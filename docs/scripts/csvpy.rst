=====
csvpy
=====

Description
===========

Loads a CSV file into a :class:`agate.csv.Reader` object and then drops into an interactive Node.js shell so the user can inspect the data however they see fit:

.. code-block:: none

   usage: csvpy [-h] [-d DELIMITER] [-t] [-q QUOTECHAR] [-u {0,1,2,3}] [-b]
                [-p ESCAPECHAR] [-z FIELD_SIZE_LIMIT] [-e ENCODING] [-L LOCALE]
                [-S] [--blanks] [--null-value NULL_VALUES [NULL_VALUES ...]]
                [--date-format DATE_FORMAT] [--datetime-format DATETIME_FORMAT]
                [-H] [-K SKIP_LINES] [-v] [-l] [--zero] [-V] [--dict] [--agate]
                [--no-number-ellipsis] [-y SNIFF_LIMIT] [-I]
                [FILE]

   Load a CSV file into a CSV reader and then drop into a Python shell.

   positional arguments:
     FILE                  The CSV file to operate on. If omitted, will accept
                           input as piped data via STDIN.

   optional arguments:
     -h, --help            show this help message and exit
     --dict                Load the CSV file into a DictReader.
     --agate               Load the CSV file into an agate table.
     --no-number-ellipsis  Disable the ellipsis if the max precision is exceeded.
     -y SNIFF_LIMIT, --snifflimit SNIFF_LIMIT
                           Limit CSV dialect sniffing to the specified number of
                           bytes. Specify "0" to disable sniffing entirely, or
                           "-1" to sniff the entire file.
     -I, --no-inference    Disable type inference (and --locale, --date-format,
                           --datetime-format, --no-leading-zeroes) when parsing
                           the input.

The shell is the Node.js REPL. ``reader`` holds the rows as arrays of strings; ``table`` (with ``--agate``) has
``columnNames`` and ``rows``.

.. note::

    Due to platform limitations, csvpy does not accept file input as piped data via STDIN. 

See also: :doc:`../common_arguments`.

Examples
========

Basic use:

.. code-block:: console

   $ csvpy examples/dummy.csv
   Welcome! "examples/dummy.csv" has been loaded in an agate.csv.reader object named "reader".
   >>> reader[0]
   [ 'a', 'b', 'c' ]

As an agate table:

.. code-block:: console

   $ csvpy --agate examples/dummy.csv
   Welcome! "examples/dummy.csv" has been loaded in an agate.Table object named "table".
   >>> table.columnNames
   [ 'a', 'b', 'c' ]
