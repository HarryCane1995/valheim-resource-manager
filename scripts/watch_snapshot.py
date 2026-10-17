"""Watch completed saves; export truthful SNAPSHOT states. No game writes or forced saves."""
import datetime as dt, json, pathlib, time, urllib.request
from read_snapshot import read_snapshot

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = ROOT/'data'/'snapshot-source.json'
CHECKPOINT = ROOT/'data'/'snapshot-checkpoint.json'

def main():
    config = json.loads(CONFIG.read_text(encoding='utf-8-sig'))
    folder = pathlib.Path(config['worldFolder'])
    generation = json.loads(CHECKPOINT.read_text()).get('generation',0) if CHECKPOINT.exists() else 0
    while True:
        try:
            complete = [int(p.name.split('.')[1]) for p in folder.glob('_main.*.ok')]
            current = max(complete,default=0)
            if current > generation:
                # Prefer the running exporter; do not repeatedly scan 1.4M ZDOs during live sync.
                url = 'http://127.0.0.1:37841/api/state?worldId='+config['worldId']
                with urllib.request.urlopen(url,timeout=3) as response: state = json.load(response)
                if not state.get('source',{}).get('connected'):
                    suffix = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%f')
                    target = ROOT/'data'/'snapshots'/f'{current}-{suffix}'
                    payload, manifest = read_snapshot(folder,target,retain_bytes=False)
                    token = (ROOT/'data'/'ingest-token.txt').read_text().strip()
                    req = urllib.request.Request('http://127.0.0.1:37841/api/snapshot',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-VRM-Token':token})
                    with urllib.request.urlopen(req,timeout=15) as response: response.read()
                    generation = manifest['generation']
                    CHECKPOINT.write_text(json.dumps({'generation':generation,'worldId':manifest['worldId'],'observedAt':manifest['observedAt']}),encoding='utf-8')
                    print(f'SNAPSHOT generation {generation}: {manifest["containers"]} recognized chests, partial coverage.',flush=True)
        except Exception as exc:
            print(f'Snapshot deferred: {type(exc).__name__}: {exc}',flush=True)
        time.sleep(5)

if __name__ == '__main__': main()
