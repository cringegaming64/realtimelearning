from pathlib import Path
import sys

path = Path(sys.argv[1])
s = path.read_text()

required = [
    "const AUDIO_RATE = 65536",
    "createScriptProcessor(1024, 0, 2)",
    "ctx.drawImage(frameCanvas",
    "smoothVideo: false",
    "lostpointercapture",
    "window.__appResume",
]
missing = [token for token in required if token not in s]
if missing:
    raise SystemExit("missing expected app features: " + ", ".join(missing))
if "createBufferSource" in s:
    raise SystemExit("legacy scheduled-source audio pipeline is still present")
path.write_text(s)
