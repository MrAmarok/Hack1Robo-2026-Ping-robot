# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11,<13"]
# ///

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sonar_mapper import main


if __name__ == "__main__":
    main()
