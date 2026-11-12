'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvjson.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests, jsonNumberKinds } = require('../utils');

/** isinstance(value, dict) for a value loaded from JSON. */
function isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('TestCSVJSON', () => {
  const t = new CSVKitTestCase('csvjson');
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_options', () => {
    t.assertError(
      ['--key', 'value', '--stream'],
      '--key is only allowed with --stream when --lat and --lon are also specified.',
    );
  });

  test('test_latlon_options', async (s) => {
    for (const [option, message] of [
      ['lat', '--lon is required whenever --lat is specified.'],
      ['lon', '--lat is required whenever --lon is specified.'],
      ['crs', '--crs is only allowed when --lat and --lon are also specified.'],
      ['type', '--type is only allowed when --lat and --lon are also specified.'],
      ['geometry', '--geometry is only allowed when --lat and --lon are also specified.'],
    ]) {
      await s.test(`option=${option}`, () => {
        t.assertError([`--${option}`, 'value'], message);
      });
    }
  });

  test('test_simple', () => {
    const js = JSON.parse(t.getOutput(['examples/dummy.csv']));
    assert.deepEqual(js[0], { a: true, c: 3.0, b: 2.0 });
  });

  test('test_sniff_limit', () => {
    const js = JSON.parse(t.getOutput(['examples/sniff_limit.csv']));
    assert.deepEqual(js[0], { a: true, c: 3.0, b: 2.0 });
  });

  test('test_tsv', () => {
    const js = JSON.parse(t.getOutput(['examples/dummy.tsv']));
    assert.deepEqual(js[0], { a: true, c: 3.0, b: 2.0 });
  });

  test('test_tsv_streaming', () => {
    const js = JSON.parse(t.getOutput(['--stream', '--no-inference',
      '--snifflimit', '0', '--tabs', 'examples/dummy.tsv']));
    assert.deepEqual(js, { a: '1', c: '3', b: '2' });
  });

  test('test_no_blanks', () => {
    const js = JSON.parse(t.getOutput(['examples/blanks.csv']));
    assert.deepEqual(js[0], { a: null, b: null, c: null, d: null, e: null, f: null });
  });

  test('test_blanks', () => {
    const js = JSON.parse(t.getOutput(['--blanks', 'examples/blanks.csv']));
    assert.deepEqual(js[0], { a: '', b: 'NA', c: 'N/A', d: 'NONE', e: 'NULL', f: '.' });
  });

  test('test_no_header_row', () => {
    const js = JSON.parse(t.getOutput(['--no-header-row', 'examples/no_header_row.csv']));
    assert.deepEqual(js[0], { a: true, c: 3.0, b: 2.0 });
  });

  test('test_no_inference', () => {
    const js = JSON.parse(t.getOutput(['--no-inference', 'examples/dummy.csv']));
    assert.deepEqual(js[0], { a: '1', c: '3', b: '2' });
  });

  test('test_indentation', () => {
    const output = t.getOutput(['-i', '4', 'examples/dummy.csv']);
    const js = JSON.parse(output);
    assert.deepEqual(js[0], { a: true, c: 3.0, b: 2.0 });
    assert.match(output, /        "a": true,/);
  });

  test('test_keying', () => {
    const js = JSON.parse(t.getOutput(['-k', 'a', 'examples/dummy.csv']));
    assert.deepEqual(js, { True: { a: true, c: 3.0, b: 2.0 } });
  });

  test('test_duplicate_keys', () => {
    assert.throws(
      () => t.getOutput(['-k', 'a', 'examples/dummy3.csv']),
      { name: 'ValueError', message: /Value True is not unique in the key column./ },
    );
  });

  test('test_geojson_with_id', () => {
    const output = t.getOutput(['--lat', 'latitude', '--lon',
      'longitude', '-k', 'slug', 'examples/test_geo.csv']);
    const geojson = JSON.parse(output);
    const kinds = jsonNumberKinds(output);

    assert.equal(geojson.type, 'FeatureCollection');
    assert.ok(!('crs' in geojson));
    assert.deepEqual(geojson.bbox, [-95.334619, 32.299076986939205, -95.250699, 32.351434]);
    assert.equal(geojson.features.length, 17);

    geojson.features.forEach((feature, i) => {
      assert.equal(feature.type, 'Feature');
      assert.ok('id' in feature);
      assert.ok('properties' in feature);
      assert.ok(isDict(feature.properties));
      assert.ok(Object.keys(feature.properties).length > 1);

      const { geometry } = feature;

      assert.equal(geometry.coordinates.length, 2);
      assert.equal(kinds.features[i].geometry.coordinates[0], 'float');
      assert.equal(kinds.features[i].geometry.coordinates[1], 'float');
    });
  });

  test('test_geojson_point', () => {
    const output = t.getOutput(['--lat', 'latitude', '--lon', 'longitude', 'examples/test_geo.csv']);
    const geojson = JSON.parse(output);
    const kinds = jsonNumberKinds(output);

    assert.equal(geojson.type, 'FeatureCollection');
    assert.ok(!('crs' in geojson));
    assert.deepEqual(geojson.bbox, [-95.334619, 32.299076986939205, -95.250699, 32.351434]);
    assert.equal(geojson.features.length, 17);

    geojson.features.forEach((feature, i) => {
      assert.equal(feature.type, 'Feature');
      assert.ok(!('id' in feature));
      assert.ok('properties' in feature);
      assert.ok(isDict(feature.properties));
      assert.ok(Object.keys(feature.properties).length > 1);

      const { geometry } = feature;

      assert.equal(geometry.coordinates.length, 2);
      assert.equal(kinds.features[i].geometry.coordinates[0], 'float');
      assert.equal(kinds.features[i].geometry.coordinates[1], 'float');
    });
  });

  test('test_geojson_shape', () => {
    const geojson = JSON.parse(t.getOutput(['--lat', 'latitude', '--lon', 'longitude',
      '--type', 'type', '--geometry', 'geojson', 'examples/test_geojson.csv']));

    assert.equal(geojson.type, 'FeatureCollection');
    assert.ok(!('crs' in geojson));
    assert.deepEqual(geojson.bbox, [100.0, 0.0, 105.0, 1.0]);
    assert.equal(geojson.features.length, 3);

    for (const feature of geojson.features) {
      assert.equal(feature.type, 'Feature');
      assert.ok(!('id' in feature));
      assert.ok('properties' in feature);
      assert.ok(isDict(feature.properties));
      assert.ok(Object.keys(feature.properties).includes('prop0'));

      const { geometry } = feature;

      assert.ok('coordinates' in geometry);
      assert.notEqual(geometry.coordinates, null);
    }

    assert.equal(geojson.features[0].geometry.type, 'Point');
    assert.equal(geojson.features[1].geometry.type, 'LineString');
    assert.equal(geojson.features[2].geometry.type, 'Polygon');

    assert.deepEqual(geojson.features[0].geometry.coordinates, [102.0, 0.5]);
    assert.deepEqual(geojson.features[1].geometry.coordinates,
      [[102.0, 0.0], [103.0, 1.0], [104.0, 0.0], [105.0, 1.0]]);
    assert.deepEqual(geojson.features[2].geometry.coordinates,
      [[[100.0, 0.0], [101.0, 0.0], [101.0, 1.0], [100.0, 1.0], [100.0, 0.0]]]);
  });

  test('test_geojson_with_crs', () => {
    const geojson = JSON.parse(t.getOutput(['--lat', 'latitude', '--lon',
      'longitude', '--crs', 'EPSG:4269', 'examples/test_geo.csv']));
    assert.ok('crs' in geojson);
    assert.deepEqual(geojson.crs, { type: 'name', properties: { name: 'EPSG:4269' } });
  });

  test('test_geojson_with_no_bbox', () => {
    const geojson = JSON.parse(t.getOutput(['--lat', 'latitude', '--lon',
      'longitude', '--no-bbox', 'examples/test_geo.csv']));
    assert.ok(!('bbox' in geojson));
  });

  test('test_ndjson', () => {
    t.assertLines(['--stream', 'examples/testjson_converted.csv'], [
      '{"text": "Chicago Reader", "float": 1.0, "datetime": "1971-01-01T04:14:00", "boolean": true, "time": "4:14:00", "date": "1971-01-01", "integer": 40.0}',
      '{"text": "Chicago Sun-Times", "float": 1.27, "datetime": "1948-01-01T14:57:13", "boolean": true, "time": "14:57:13", "date": "1948-01-01", "integer": 63.0}',
      '{"text": "Chicago Tribune", "float": 41800000.01, "datetime": "1920-01-01T00:00:00", "boolean": false, "time": "0:00:00", "date": "1920-01-01", "integer": 164.0}',
      '{"text": "This row has blanks", "float": null, "datetime": null, "boolean": null, "time": null, "date": null, "integer": null}',
      '{"text": "Unicode! Σ", "float": null, "datetime": null, "boolean": null, "time": null, "date": null, "integer": null}',
    ]);
  });

  test('test_ndjson_streaming', () => {
    t.assertLines(['--stream', '--no-inference', '--snifflimit', '0', 'examples/testjson_converted.csv'], [
      '{"text": "Chicago Reader", "float": "1.0", "datetime": "1971-01-01T04:14:00", "boolean": "True", "time": "4:14:00", "date": "1971-01-01", "integer": "40"}',
      '{"text": "Chicago Sun-Times", "float": "1.27", "datetime": "1948-01-01T14:57:13", "boolean": "True", "time": "14:57:13", "date": "1948-01-01", "integer": "63"}',
      '{"text": "Chicago Tribune", "float": "41800000.01", "datetime": "1920-01-01T00:00:00", "boolean": "False", "time": "0:00:00", "date": "1920-01-01", "integer": "164"}',
      '{"text": "This row has blanks", "float": "", "datetime": "", "boolean": "", "time": "", "date": "", "integer": ""}',
      '{"text": "Unicode! Σ", "float": "", "datetime": "", "boolean": "", "time": "", "date": "", "integer": ""}',
    ]);
  });

  test('test_ndgeojson', () => {
    t.assertLines(['--lat', 'latitude', '--lon', 'longitude', '--stream', 'examples/test_geo.csv'], [
      '{"type": "Feature", "properties": {"slug": "dcl", "title": "Downtown Coffee Lounge", "description": "In addition to being the only coffee shop in downtown Tyler, DCL also features regular exhibitions of work by local artists.", "address": "200 West Erwin Street", "type": "Gallery", "last_seen_date": "2012-03-30"}, "geometry": {"type": "Point", "coordinates": [-95.30181, 32.35066]}}',
      '{"type": "Feature", "properties": {"slug": "tyler-museum", "title": "Tyler Museum of Art", "description": "The Tyler Museum of Art on the campus of Tyler Junior College is the largest art museum in Tyler. Visit them online at <a href=\\"http://www.tylermuseum.org/\\">http://www.tylermuseum.org/</a>.", "address": "1300 South Mahon Avenue", "type": "Museum", "last_seen_date": "2012-04-02"}, "geometry": {"type": "Point", "coordinates": [-95.28174, 32.33396]}}',
      '{"type": "Feature", "properties": {"slug": "genecov", "title": "Genecov Sculpture", "description": "Stainless Steel Sculpture", "address": "1350 Dominion Plaza", "type": "Sculpture", "photo_url": "http://i.imgur.com/DICdn.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-04"}, "geometry": {"type": "Point", "coordinates": [-95.31571447849274, 32.299076986939205]}}',
      '{"type": "Feature", "properties": {"slug": "gallery-main-street", "title": "Gallery Main Street", "description": "The only dedicated art gallery in Tyler. Visit them online at <a href=\\"http://www.heartoftyler.com/downtowntylerarts/\\">http://www.heartoftyler.com/downtowntylerarts/</a>.", "address": "110 West Erwin Street", "type": "Gallery", "last_seen_date": "2012-04-09"}, "geometry": {"type": "Point", "coordinates": [-95.30123, 32.35066]}}',
      '{"type": "Feature", "properties": {"slug": "spirit-of-progress", "title": "The Spirit of Progress", "address": "100 block of North Spring Avenue", "type": "Relief", "photo_url": "http://media.hacktyler.com/artmap/photos/spirit-of-progress.jpg", "photo_credit": "Photo by Christopher Groskopf. Used with permission.", "last_seen_date": "2012-04-11"}, "geometry": {"type": "Point", "coordinates": [-95.2995, 32.3513]}}',
      '{"type": "Feature", "properties": {"slug": "celestial-conversations-2", "title": "Celestial Conversations #2", "artist": "Simon Saleh", "description": "Steel Sculpture", "address": "100 block of North Spring Avenue", "type": "Sculpture", "photo_url": "http://media.hacktyler.com/artmap/photos/celestial-conversations-2.jpg", "photo_credit": "Photo by Christopher Groskopf. Used with permission.", "last_seen_date": "2012-04-11"}, "geometry": {"type": "Point", "coordinates": [-95.2995, 32.351]}}',
      '{"type": "Feature", "properties": {"slug": "pivot-bounce", "title": "Pivot Bounce", "artist": "Chelsea Cope", "address": "100 block of North Spring Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/pmxyi.jpg?1", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-11"}, "geometry": {"type": "Point", "coordinates": [-95.29944, 32.351434]}}',
      '{"type": "Feature", "properties": {"slug": "children-of-peace", "title": "Children of Peace", "artist": "Gary Price", "description": "Cast Bronze", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/rUikO.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.300222, 32.339826]}}',
      '{"type": "Feature", "properties": {"slug": "ross-bears", "title": "Ross\' Bears", "description": "Granite Sculpture", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/SpJQI.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.300034, 32.339776]}}',
      '{"type": "Feature", "properties": {"slug": "butterfly-garden", "title": "Butterfly Garden", "description": "Cast Bronze", "type": "Sculpture", "photo_url": "http://i.imgur.com/0L8DF.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.300219, 32.339559]}}',
      '{"type": "Feature", "properties": {"slug": "goose-fountain", "title": "TJC Goose Fountain", "description": "Copper (?) Sculpture", "address": "1300 S. Mahon Ave.", "type": "Sculpture", "photo_url": "http://i.imgur.com/UWfS6.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.28263, 32.333944]}}',
      '{"type": "Feature", "properties": {"slug": "tjc-cement-totems", "description": "Cast Cement Totems", "address": "1300 S. Mahon Ave.", "type": "Sculpture", "photo_url": "http://i.imgur.com/lRmYd.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.283894, 32.333899]}}',
      '{"type": "Feature", "properties": {"slug": "alison", "title": "Alison", "description": "Cast Bronze", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/7OcrG.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.299887, 32.339809]}}',
      '{"type": "Feature", "properties": {"slug": "jackson", "title": "Jackson", "description": "Cast Bronze", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/aQJfv.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.299939, 32.339828]}}',
      '{"type": "Feature", "properties": {"slug": "505-third", "title": "Untitled", "description": "Stainless Steel", "address": "505 Third St.", "type": "Sculpture", "photo_url": "http://i.imgur.com/0moUY.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.305429, 32.333082]}}',
      '{"type": "Feature", "properties": {"slug": "obeidder", "title": "Obeidder Monster", "description": "Sharpie and Spray Paint", "address": "3319 Seaton St.", "type": "Street Art", "photo_url": "http://i.imgur.com/3aX7E.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "2012-04-15"}, "geometry": {"type": "Point", "coordinates": [-95.334619, 32.314431]}}',
      '{"type": "Feature", "properties": {"slug": "sensor-device", "title": "Sensor Device", "artist": "Kurt Dyrhaug", "address": "University of Texas, Campus Drive", "type": "Sculpture", "photo_url": "http://media.hacktyler.com/artmap/photos/sensor-device.jpg", "photo_credit": "Photo by Christopher Groskopf. Used with permission.", "last_seen_date": "2012-04-16"}, "geometry": {"type": "Point", "coordinates": [-95.250699, 32.317216]}}',
    ]);
  });

  test('test_ndgeojson_streaming', () => {
    t.assertLines(['--stream', '--no-inference', '--snifflimit', '0', '--lat', 'latitude', '--lon', 'longitude',
      '--stream', 'examples/test_geo.csv'], [
      '{"type": "Feature", "properties": {"slug": "dcl", "title": "Downtown Coffee Lounge", "description": "In addition to being the only coffee shop in downtown Tyler, DCL also features regular exhibitions of work by local artists.", "address": "200 West Erwin Street", "type": "Gallery", "last_seen_date": "3/30/12"}, "geometry": {"type": "Point", "coordinates": [-95.30181, 32.35066]}}',
      '{"type": "Feature", "properties": {"slug": "tyler-museum", "title": "Tyler Museum of Art", "description": "The Tyler Museum of Art on the campus of Tyler Junior College is the largest art museum in Tyler. Visit them online at <a href=\\"http://www.tylermuseum.org/\\">http://www.tylermuseum.org/</a>.", "address": "1300 South Mahon Avenue", "type": "Museum", "last_seen_date": "4/2/12"}, "geometry": {"type": "Point", "coordinates": [-95.28174, 32.33396]}}',
      '{"type": "Feature", "properties": {"slug": "genecov", "title": "Genecov Sculpture", "description": "Stainless Steel Sculpture", "address": "1350 Dominion Plaza", "type": "Sculpture", "photo_url": "http://i.imgur.com/DICdn.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/4/12"}, "geometry": {"type": "Point", "coordinates": [-95.31571447849274, 32.299076986939205]}}',
      '{"type": "Feature", "properties": {"slug": "gallery-main-street", "title": "Gallery Main Street", "description": "The only dedicated art gallery in Tyler. Visit them online at <a href=\\"http://www.heartoftyler.com/downtowntylerarts/\\">http://www.heartoftyler.com/downtowntylerarts/</a>.", "address": "110 West Erwin Street", "type": "Gallery", "last_seen_date": "4/9/12"}, "geometry": {"type": "Point", "coordinates": [-95.30123, 32.35066]}}',
      '{"type": "Feature", "properties": {"slug": "spirit-of-progress", "title": "The Spirit of Progress", "address": "100 block of North Spring Avenue", "type": "Relief", "photo_url": "http://media.hacktyler.com/artmap/photos/spirit-of-progress.jpg", "photo_credit": "Photo by Christopher Groskopf. Used with permission.", "last_seen_date": "4/11/12"}, "geometry": {"type": "Point", "coordinates": [-95.2995, 32.3513]}}',
      '{"type": "Feature", "properties": {"slug": "celestial-conversations-2", "title": "Celestial Conversations #2", "artist": "Simon Saleh", "description": "Steel Sculpture", "address": "100 block of North Spring Avenue", "type": "Sculpture", "photo_url": "http://media.hacktyler.com/artmap/photos/celestial-conversations-2.jpg", "photo_credit": "Photo by Christopher Groskopf. Used with permission.", "last_seen_date": "4/11/12"}, "geometry": {"type": "Point", "coordinates": [-95.2995, 32.351]}}',
      '{"type": "Feature", "properties": {"slug": "pivot-bounce", "title": "Pivot Bounce", "artist": "Chelsea Cope", "address": "100 block of North Spring Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/pmxyi.jpg?1", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/11/12"}, "geometry": {"type": "Point", "coordinates": [-95.29944, 32.351434]}}',
      '{"type": "Feature", "properties": {"slug": "children-of-peace", "title": "Children of Peace", "artist": "Gary Price", "description": "Cast Bronze", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/rUikO.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.300222, 32.339826]}}',
      '{"type": "Feature", "properties": {"slug": "ross-bears", "title": "Ross\' Bears", "description": "Granite Sculpture", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/SpJQI.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.300034, 32.339776]}}',
      '{"type": "Feature", "properties": {"slug": "butterfly-garden", "title": "Butterfly Garden", "description": "Cast Bronze", "type": "Sculpture", "photo_url": "http://i.imgur.com/0L8DF.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.300219, 32.339559]}}',
      '{"type": "Feature", "properties": {"slug": "goose-fountain", "title": "TJC Goose Fountain", "description": "Copper (?) Sculpture", "address": "1300 S. Mahon Ave.", "type": "Sculpture", "photo_url": "http://i.imgur.com/UWfS6.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.28263, 32.333944]}}',
      '{"type": "Feature", "properties": {"slug": "tjc-cement-totems", "description": "Cast Cement Totems", "address": "1300 S. Mahon Ave.", "type": "Sculpture", "photo_url": "http://i.imgur.com/lRmYd.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.283894, 32.333899]}}',
      '{"type": "Feature", "properties": {"slug": "alison", "title": "Alison", "description": "Cast Bronze", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/7OcrG.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.299887, 32.339809]}}',
      '{"type": "Feature", "properties": {"slug": "jackson", "title": "Jackson", "description": "Cast Bronze", "address": "900 South Broadway Avenue", "type": "Sculpture", "photo_url": "http://i.imgur.com/aQJfv.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.299939, 32.339828]}}',
      '{"type": "Feature", "properties": {"slug": "505-third", "title": "Untitled", "description": "Stainless Steel", "address": "505 Third St.", "type": "Sculpture", "photo_url": "http://i.imgur.com/0moUY.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.305429, 32.333082]}}',
      '{"type": "Feature", "properties": {"slug": "obeidder", "title": "Obeidder Monster", "description": "Sharpie and Spray Paint", "address": "3319 Seaton St.", "type": "Street Art", "photo_url": "http://i.imgur.com/3aX7E.jpg", "photo_credit": "Photo by Justin Edwards. Used with permission.", "last_seen_date": "4/15/12"}, "geometry": {"type": "Point", "coordinates": [-95.334619, 32.314431]}}',
      '{"type": "Feature", "properties": {"slug": "sensor-device", "title": "Sensor Device", "artist": "Kurt Dyrhaug", "address": "University of Texas, Campus Drive", "type": "Sculpture", "photo_url": "http://media.hacktyler.com/artmap/photos/sensor-device.jpg", "photo_credit": "Photo by Christopher Groskopf. Used with permission.", "last_seen_date": "4/16/12"}, "geometry": {"type": "Point", "coordinates": [-95.250699, 32.317216]}}',
    ]);
  });
});
