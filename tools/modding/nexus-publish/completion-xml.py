"""Bounded stdlib XML validation. stdin only, fixed exit status; never echo storage bodies."""
import json
import sys
import xml.etree.ElementTree as ET


def parse(text, limit):
    if not isinstance(text, str) or len(text.encode("utf-8")) > limit:
        raise ValueError()
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        raise ValueError()
    root = ET.fromstring(text)
    for node in root.iter():
        if node.tag.startswith("{") and not node.tag.startswith("{http://s3.amazonaws.com/doc/2006-03-01/}"):
            raise ValueError()
        node.tag = node.tag.rsplit("}", 1)[-1]
        if node.tag == "Error":
            raise ValueError()
    return root


def validate(data):
    request = parse(data["request"], 3_000_000)
    if request.tag != "CompleteMultipartUpload":
        raise ValueError()
    parts = []
    for node in request:
        if node.tag != "Part" or [child.tag for child in node] != ["PartNumber", "ETag"]:
            raise ValueError()
        parts.append([int(node[0].text), node[1].text])
    if parts != data["parts"]:
        raise ValueError()
    if data["response"] is None:
        return True
    response = parse(data["response"], 65536)
    if response.tag != "CompleteMultipartUploadResult":
        raise ValueError()
    # AWS success schema: reject empty/malformed success, not merely the presence of HTTP 200.
    for name in ("Bucket", "Key", "ETag"):
        nodes = response.findall(name)
        if len(nodes) != 1 or not nodes[0].text or list(nodes[0]):
            raise ValueError()
    return True


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(6_000_001)
        if len(raw) > 6_000_000: raise ValueError()
        validate(json.loads(raw))
    except (ValueError, TypeError, KeyError, ET.ParseError, AttributeError):
        raise SystemExit(2)
