import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import paths from './paths.cjs';
import {createImmutableRecordIO, identity, generation} from './immutable-records.mjs';
import { validatePlan, planQueue } from './plan-contract.mjs';

const MAX_BYTES = 1024 * 1024, MAX_EVENTS = 205;
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, code) => { if (!ok) throw Error(code); };
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n));
const at = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(value);
function safe(fn) {
  try { return fn(); }
  catch (error) { throw Error(/^PLAN_JOURNAL_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PLAN_JOURNAL_IO_FAILED'); }
}
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
function encoded(value) {
  const bytes = Buffer.from(JSON.stringify(canonical(value)) + '\n');
  need(bytes.length <= MAX_BYTES, 'PLAN_JOURNAL_LIMIT'); return bytes;
}
function frozenPlan(value) {
  try {
    // Revalidate the detached semantic form as well (e.g. sparse arrays become null).
    const plan = validatePlan(validatePlan(value)); encoded(plan); return plan;
  } catch (error) {
    throw Error(error?.message === 'PLAN_JOURNAL_LIMIT' ? error.message : 'PLAN_JOURNAL_INVALID_PLAN');
  }
}
export function canonicalPlanId(value) {
  return crypto.createHash('sha256').update(encoded(frozenPlan(value))).digest('hex');
}
const {ancestry, sameAncestry, readJSON, publish} = createImmutableRecordIO({maxBytes: MAX_BYTES, prefix: 'PLAN_JOURNAL_'});
const eventName = number => String(number).padStart(6, '0') + '.json';
function transitions(planId, queue, events) {
  let observed = 0, pending = null, terminal = null;
  for (let n = 0; n < events.length; n++) {
    const event = events[n], common = ['schema', 'planId', 'sequence', 'at', 'kind'];
    need(object(event) && event.schema === 'mod-plan-event/1' && event.planId === planId && event.sequence === n + 1
      && at(event.at) && !terminal, 'PLAN_JOURNAL_CORRUPT');
    if (event.kind === 'intent') {
      need(exact(event, [...common, 'index', 'operation', 'args']) && pending === null && event.index === observed
        && event.index < queue.length && event.operation === queue[event.index].operation
        && encoded(event.args).equals(encoded(queue[event.index].args)), 'PLAN_JOURNAL_CORRUPT'); pending = event.index;
    } else if (event.kind === 'observed') {
      need(exact(event, [...common, 'index']) && pending !== null && event.index === pending, 'PLAN_JOURNAL_CORRUPT');
      observed++; pending = null;
    } else {
      need(event.kind === 'terminal' && exact(event, [...common, 'status', 'code'])
        && (event.status === 'completed' && event.code === null && pending === null && observed === queue.length
          || event.status === 'stopped' && code(event.code)), 'PLAN_JOURNAL_CORRUPT'); terminal = event;
    }
  }
  return { state: terminal?.status ?? (pending !== null ? 'inflight' : observed ? 'running' : 'prepared'),
    observed, pending, terminal };
}

export function createPlanJournal(options = {}) {
  need(object(options) && Object.keys(options).every(k => k === 'root'), 'PLAN_JOURNAL_INVALID_OPTIONS');
  const candidate = options.root ?? path.join(paths.resolvePaths().build, 'plan-journals');
  need(typeof candidate === 'string' && path.isAbsolute(candidate) && !/[\x00-\x1f]/.test(candidate), 'PLAN_JOURNAL_INVALID_ROOT');
  const root = path.resolve(candidate), seen = new Set(); let rootPins;
  function roots(create) {
    const current = ancestry(root, create);
    if (rootPins) { need(current, 'PLAN_JOURNAL_PATH_CHANGED'); sameAncestry(root, rootPins); }
    else if (current) rootPins = current;
    return current;
  }
  function read(planId) {
    return safe(() => {
      need(id(planId), 'PLAN_JOURNAL_INVALID_ID');
      if (!roots(false)) return null;
      const dir = path.join(root, planId); let directory;
      try { directory = fs.lstatSync(dir, { bigint: true }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        need(!seen.has(planId), 'PLAN_JOURNAL_PATH_CHANGED'); return null;
      }
      need(directory.isDirectory() && !directory.isSymbolicLink(), 'PLAN_JOURNAL_UNSAFE_PATH');
      const pins = ancestry(dir), names = fs.readdirSync(dir).sort();
      sameAncestry(root, rootPins);
      need(names.length > 0 && names.length <= MAX_EVENTS + 1 && names.includes('plan.json')
        && names.every(n => n === 'plan.json' || /^\d{6}\.json$/.test(n)), 'PLAN_JOURNAL_CORRUPT');
      const observations = new Map(), record = readJSON(path.join(dir, 'plan.json'), observations);
      need(exact(record, ['schema', 'planId', 'at', 'rootId', 'directoryId', 'plan']) && record.schema === 'mod-plan-journal/1'
        && record.planId === planId && at(record.at) && record.rootId === rootPins.get(root)
        && record.directoryId === identity(directory), 'PLAN_JOURNAL_CORRUPT');
      const plan = frozenPlan(record.plan), queue = planQueue(plan);
      need(canonicalPlanId(plan) === planId && queue.length <= 101, 'PLAN_JOURNAL_CORRUPT');
      const files = names.filter(n => n !== 'plan.json');
      need(files.every((name, n) => name === eventName(n + 1)), 'PLAN_JOURNAL_CORRUPT');
      const events = files.map(name => readJSON(path.join(dir, name), observations)), result = transitions(planId, queue, events);
      sameAncestry(dir, pins); seen.add(planId);
      need(JSON.stringify(fs.readdirSync(dir).sort()) === JSON.stringify(names)
        && [...observations].every(([file, stamp]) => generation(fs.lstatSync(file, { bigint: true })) === stamp), 'PLAN_JOURNAL_CHANGED');
      return { planId, plan, events, valid: true, ...result };
    });
  }
  function begin(value) {
    return safe(() => {
      const plan = frozenPlan(value), planId = canonicalPlanId(plan), queue = planQueue(plan);
      need(queue.length <= 101, 'PLAN_JOURNAL_LIMIT');
      roots(true);
      const dir = path.join(root, planId);
      try { fs.mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') throw Error('PLAN_JOURNAL_EXISTS_HOLD'); throw error; }
      const pins = ancestry(dir), files = new Map(), events = []; let held = false;
      // Reservation must not adopt a replacement root as its new authority.
      sameAncestry(root, rootPins);
      seen.add(planId);
      function guard() {
        need(!held, 'PLAN_JOURNAL_HELD'); sameAncestry(dir, pins);
        const names = fs.readdirSync(dir).sort();
        need(JSON.stringify(names) === JSON.stringify([...files.keys()].sort()), 'PLAN_JOURNAL_CHANGED');
        for (const [name, stamp] of files) {
          const stat = fs.lstatSync(path.join(dir, name), { bigint: true });
          need(stat.isFile() && !stat.isSymbolicLink() && generation(stat) === stamp, 'PLAN_JOURNAL_CHANGED');
        }
      }
      function write(name, value) {
        const bytes = encoded(value);
        try {files.set(name, publish(dir, name, bytes, pins, guard));}
        catch (error) {held = true; throw error;}
      }
      try {
        write('plan.json', { schema: 'mod-plan-journal/1', planId, at: new Date().toISOString(),
          rootId: rootPins.get(root), directoryId: pins.get(dir), plan });
      } catch (error) { held = true; throw error; }
      function append(event) {
        return safe(() => {
          need(!held, 'PLAN_JOURNAL_HELD');
          try {
            need(events.length < MAX_EVENTS, 'PLAN_JOURNAL_LIMIT');
            const next = { schema: 'mod-plan-event/1', planId, sequence: events.length + 1, at: new Date().toISOString(), ...event };
            transitions(planId, queue, [...events, next]);
            write(eventName(next.sequence), next); events.push(next);
          } catch (error) { held = true; throw error; }
        });
      }
      return Object.freeze({ planId,
        intent(index, operation, args) {
          return safe(() => {
            try { return append({ kind: 'intent', index, operation, args: JSON.parse(encoded(args)) }); }
            catch (error) { held = true; throw error; }
          });
        },
        observed(index) { return append({ kind: 'observed', index }); },
        finish(status, reason) { return append({ kind: 'terminal', status, code: reason ?? null }); },
      });
    });
  }
  return Object.freeze({ begin, read });
}
