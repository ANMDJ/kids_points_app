"""把 /srv/kids-points/kids.env 的 APP_* 段更新到指定版本（发布用，2026-11-05）。

用法（服务器上）： sudo python3 /tmp/update_app_env.py 1.0.6 7 "release notes"
幂等：重复跑同一组参数得到同样结果。改前备份到 kids.env.bak-<时间戳>。
"""
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

PATH = Path('/srv/kids-points/kids.env')

version = sys.argv[1]
build = sys.argv[2]
notes = sys.argv[3] if len(sys.argv) > 3 else ''
if notes.startswith('@'):
    # 中文引号/分号直接走 ssh 命令行容易被 shell 改写，改为从文件读。
    notes = Path(notes[1:]).read_text(encoding='utf-8').strip()

text = PATH.read_text(encoding='utf-8')

start = text.index('APP_LATEST_VERSION=')
anchor = text.index('\nAPP_RELEASE_NOTES="', start)
end = text.index('\n', anchor + 1) + 1

published = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

block = (
    '# W10-B App 版本（2026-11-05 起由发布流程写入；改完 docker compose up -d）\n'
    f'APP_LATEST_VERSION="{version}"\n'
    f'APP_LATEST_BUILD="{build}"\n'
    'APP_MINIMUM_VERSION="1.0.0"\n'
    'APP_MINIMUM_BUILD="1"\n'
    'APP_DOWNLOAD_URL="https://hub.littlewish.top:8443/app/kids-points-app.apk"\n'
    f'APP_PUBLISHED_AT="{published}"\n'
    f'APP_RELEASE_NOTES="{notes}"\n'
)

backup = PATH.with_suffix('.env.bak-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
shutil.copy2(PATH, backup)

PATH.write_text(text[:start] + block + text[end:], encoding='utf-8')
print(f'[ok] kids.env 已更新为 {version}+{build}（publishedAt={published}）')
print(f'[backup] {backup}')
