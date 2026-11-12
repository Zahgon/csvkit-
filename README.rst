.. image:: https://github.com/wireservice/csvkit/workflows/CI/badge.svg
    :target: https://github.com/wireservice/csvkit/actions
    :alt: Build status

csvkit is a suite of command-line tools for converting to and working with CSV, the king of tabular file formats.

It is inspired by pdftk, GDAL and the original csvcut tool by Joe Germuska and Aaron Bycoffe.

Important links:

* Documentation: https://csvkit.rtfd.org/
* Repository:    https://github.com/wireservice/csvkit
* Issues:        https://github.com/wireservice/csvkit/issues
* Schemas:       https://github.com/wireservice/ffs

Installation
------------

This is the JavaScript port of csvkit 2.2.0. It needs Node.js 22 or later and uses only Node.js built-in modules,
so there are no dependencies to install. From a clone of the repository:

.. code-block:: bash

   npm install --global .

This puts the fourteen tools on your ``PATH``: ``csvclean``, ``csvcut``, ``csvformat``, ``csvgrep``, ``csvjoin``,
``csvjson``, ``csvlook``, ``csvpy``, ``csvsort``, ``csvsql``, ``csvstack``, ``csvstat``, ``in2csv`` and ``sql2csv``.
Each tool can also be run in place, for example ``node bin/csvlook.js examples/dummy.csv``.

The ``Dockerfile`` builds an image with the tools installed: ``docker build -t csvkit .`` then, for example,
``docker run --rm -i csvkit csvlook < examples/dummy.csv``.

Usage
-----

.. code-block:: bash

   in2csv examples/dummy.xlsx | csvlook
   csvcut -c a,c examples/dummy.csv | csvjson --indent 2
   csvstat examples/realdata/FY09_EDU_Recipients_by_State.csv
   csvsql --query "select a, b from dummy" examples/dummy.csv

``csvsql`` and ``sql2csv`` work with SQLite databases (``sqlite:///path.db``) through Node.js's built-in
``node:sqlite`` module.

Development
-----------

Run the test suite, Node.js's built-in test runner over ``test/``:

.. code-block:: bash

   npm test
