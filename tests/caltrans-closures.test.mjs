import assert from "node:assert/strict";
import test from "node:test";
import { parseCaltransClosures } from "../lib/caltrans-closures.ts";

test("parses and deduplicates Caltrans full closure points", () => {
  const kml = `
    <kml><Document>
      <Placemark><styleUrl>#full-closure</styleUrl><Point><coordinates>-121.9,36.5,0</coordinates></Point>
        <description><![CDATA[<h2 class="iw-title">SR 1 at Coast Road</h2><p class="iw-text">Closed in both directions</p><span>Closure ID: C-100, Last updated: today</span>]]></description></Placemark>
      <Placemark><styleUrl>#full-closure</styleUrl><Point><coordinates>-121.8,36.6,0</coordinates></Point>
        <description><![CDATA[<h2 class="iw-title">Duplicate</h2><span>Closure ID: C-100, Last updated: today</span>]]></description></Placemark>
      <Placemark><styleUrl>#lane-closure</styleUrl><Point><coordinates>-120,37,0</coordinates></Point></Placemark>
      <Placemark><styleUrl>#pending-full-closure</styleUrl><Point><coordinates>-122,37,0</coordinates></Point>
        <description><![CDATA[<h2 class="iw-title">Pending closure</h2><span>Closure ID: C-200, Last updated: tomorrow</span>]]></description></Placemark>
    </Document></kml>`;
  const result = parseCaltransClosures(kml);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0].geometry.coordinates, [-121.9, 36.5]);
  assert.equal(result.features[0].properties.title, "SR 1 at Coast Road");
  assert.equal(result.features[1].properties.closureClass, "pending");
});
