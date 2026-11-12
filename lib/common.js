'use strict';
// Options shared by the tools that build an agate table.

/**
 * Adds the --snifflimit and --no-inference options of the tools that build an agate table.
 * @param {import('./argparse').ArgumentParser} p
 */
function addSniffAndInference(p) {
  p.addArgument(['-y', '--snifflimit'], {
    dest: 'sniff_limit', type: 'int', default: 1024,
    help: 'Limit CSV dialect sniffing to the specified number of bytes. Specify "0" to disable sniffing entirely, or "-1" to sniff the entire file.',
  });
  p.addArgument(['-I', '--no-inference'], {
    dest: 'no_inference', action: 'store_true',
    help: 'Disable type inference (and --locale, --date-format, --datetime-format, --no-leading-zeroes) when parsing the input.',
  });
}

module.exports = { addSniffAndInference };
