"""Audit the exact Git index before public publication; reports never include matched secrets."""
from __future__ import annotations
import argparse
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FORBIDDEN_DIRS = {'data', 'localdata', 'output', '.runtime', '.playwright-cli', 'node_modules', 'dist',
                  'bin', 'obj', '__pycache__', 'worlds', 'worlds_local', 'characters',
                  'characters_local', 'backups', 'decompiled', 'references'}
FORBIDDEN_SUFFIXES = {'.dll', '.exe', '.pdb', '.nupkg', '.zip', '.7z', '.tar', '.gz',
                      '.db', '.db2', '.sqlite', '.sqlite3', '.fwl', '.fwl2', '.fch', '.fch2',
                      '.chunk', '.chunks', '.ok', '.log', '.pid', '.key', '.pem', '.pfx',
                      '.p12', '.cfg', '.pyc', '.asset', '.bundle', '.unity', '.fbx', '.assets', '.ress',
                      '.png', '.webp', '.jpg', '.jpeg', '.dds', '.tga'}
PATTERNS = {
    'personal_absolute_path': re.compile(r'(?i)\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s<>"\']+|/(?:home|Users)/[^/\s<>"\']+'),
    'github_credential': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b'),
    'cloud_access_key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'private_key': re.compile(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----'),
    'credential_in_url': re.compile(r'https?://[^\s/@]+:[^\s/@]+@[^\s/]+'),
    'email_address': re.compile(r'\b[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def audit(denylist: pathlib.Path | None = None):
    private_values = []
    if denylist:
        values = json.loads(denylist.read_text(encoding='utf-8-sig'))
        if not isinstance(values, list) or any(not isinstance(v, str) or not v for v in values):
            raise ValueError('Private denylist must be a JSON array of nonempty strings')
        private_values.extend(values)
    # Compare the actual local ingest secret without printing or publishing it.
    token_file = ROOT / 'data' / 'ingest-token.txt'
    if token_file.exists():
        token = token_file.read_text().strip()
        if token: private_values.append(token)
    staged = git('ls-files', '--cached', '-z').decode('utf-8').split('\0')
    files = [p for p in staged if p]
    findings = []
    if not files: findings.append({'file': '(index)', 'line': 0, 'kind': 'empty_index'})
    for name in files:
        path = pathlib.PurePosixPath(name)
        parts = {part.lower() for part in path.parts[:-1]}
        lower = name.lower()
        if parts & FORBIDDEN_DIRS or path.suffix.lower() in FORBIDDEN_SUFFIXES or re.search(r'\.(?:db|fwl|fch)\.(?:old|bak)$|\.(?:sqlite3?|db)-(?:wal|shm)$', lower):
            findings.append({'file': name, 'line': 0, 'kind': 'private_or_binary_artifact'})
        if path.name.startswith('.env') and path.name != '.env.example':
            findings.append({'file': name, 'line': 0, 'kind': 'environment_file'})
        if lower in {'docs/game-audit.md', 'docs/qa-report.md'} or lower.startswith('tools/game-audit/') and path.suffix.lower() == '.json':
            findings.append({'file': name, 'line': 0, 'kind': 'private_machine_evidence'})
        raw = git('show', ':' + name)
        try:
            content = raw.decode('utf-8-sig')
            if '\0' in content: raise UnicodeError('NUL')
        except UnicodeError:
            findings.append({'file': name, 'line': 0, 'kind': 'non_text_file_needs_manual_license_review'})
            continue
        for number, line in enumerate(content.splitlines(), 1):
            if any(value in line for value in private_values):
                findings.append({'file': name, 'line': number, 'kind': 'private_local_value'})
            for kind, pattern in PATTERNS.items():
                for match in pattern.finditer(line):
                    if kind == 'email_address' and match.group().lower().endswith('@users.noreply.github.com'):
                        continue
                    findings.append({'file': name, 'line': number, 'kind': kind})
                    break
    return {'result': 'PASS' if not findings else 'FAIL', 'scope': 'exact Git index bytes',
            'filesChecked': len(files), 'findings': findings,
            'limitation': 'Pattern scanning does not prove absence of every secret or license issue; review the staged file list.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-denylist', type=pathlib.Path, help='Optional local-only JSON values; do not commit this file')
    args = parser.parse_args()
    report = audit(args.private_denylist)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report['result'] == 'PASS' else 1)
