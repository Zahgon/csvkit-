'use strict';
// Port of csvkit 2.2.0 tests/performance.py (MIT): times repeated runs of some tools on examples/iris.csv.
// A benchmark, not a test: run it with `node test/performance.js` from the repository root.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const NUM_REPEATS = 100; // number of repeats for timing
const ROOT = path.join(__dirname, '..');

/**
 * Runs a tool NUM_REPEATS times on examples/iris.csv, its output discarded, and prints the elapsed time.
 * @param {string} tool tool name
 */
function testPerformance(tool) {
  const command = [path.join(ROOT, 'bin', `${tool}.js`), path.join('examples', 'iris.csv')];
  const start = process.hrtime.bigint();
  for (let i = 0; i < NUM_REPEATS; i++) {
    spawnSync(process.execPath, command, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
  console.log(`CSVKit ${tool} performance test elapsed time: ${elapsed} seconds`);
}

// Upstream also defines csvpy and csvsql runs but leaves them commented out.
for (const tool of ['csvformat', 'csvjson', 'csvlook', 'csvstat']) testPerformance(tool);
