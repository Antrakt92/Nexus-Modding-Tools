'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = 'D:/Modding/Nexus/local-state/vortex-agent-build/credentials';
function powershell(script, input = '') {
  if (process.platform !== 'win32') throw new Error('WINDOWS_DPAPI_REQUIRED');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " + script, 'utf16le').toString('base64')],
    { input, encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error('DPAPI_CREDENTIAL_OPERATION_FAILED'); }
}
function sid() { return powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'); }
function protect(token) {
  return powershell("$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", token);
}
function unprotect(blob) {
  return powershell("$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", blob);
}
async function initialize(root = ROOT) {
  const user = sid();
  await fs.mkdir(root, { recursive: true });
  // Restrict the credential directory BEFORE writing even protected credential bytes.
  powershell("$p=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)", root);
  const handle = await fs.open(path.join(root, user + '.dpapi'), 'wx');
  try { await handle.writeFile(protect(crypto.randomBytes(32).toString('hex'))); await handle.sync(); }
  finally { await handle.close(); }
}
let cachedSid;
const cache = new Map();
async function readToken(root = ROOT) {
  try {
    cachedSid ||= sid();
    const file = path.join(root, cachedSid + '.dpapi'), stat = await fs.stat(file);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cache.get(file)?.stamp === stamp) return cache.get(file).token;
    if (stat.size > 4096) throw new Error();
    const blob = await fs.readFile(file, 'utf8');
    const token = unprotect(blob);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
    cache.set(file, { stamp, token }); return token;
  } catch { throw new Error('CREDENTIAL_NOT_INITIALIZED_RUN_CREDENTIAL_HELPER'); }
}
function authorized(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string') return false;
  const expected = Buffer.from('Bearer ' + token), actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
module.exports = { ROOT, initialize, readToken, protect, unprotect, authorized };
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--initialize') { process.stderr.write('Usage: credential.cjs --initialize\n'); process.exitCode = 1; }
  else initialize().then(() => process.stdout.write('Per-user DPAPI credential initialized. No token is printed.\n'),
    () => { process.stderr.write('Credential initialization failed or credential already exists; inspect privately.\n'); process.exitCode = 1; });
}
