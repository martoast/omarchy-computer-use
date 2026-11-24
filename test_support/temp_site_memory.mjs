// Tests never write into the user's own site memory (~/.local/share/omarchy-computer-use/sites): every server a test
// starts inherits this temp folder. Import it first in any test that starts index.js.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.COMPUTER_USE_SITEMAP_DIR = mkdtempSync(path.join(os.tmpdir(), "cu-test-sites-"));
