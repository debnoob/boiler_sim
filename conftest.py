"""Pytest bootstrap.

The engine modules are imported flat (`import ai_analyst`), not as a package, so
the engine directory has to be on sys.path before collection.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "engine"))
