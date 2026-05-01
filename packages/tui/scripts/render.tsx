// Render each screen via ink-testing-library at a fixed width and dump
// the last frame to stdout for visual inspection. Not a real test suite —
// just a verification harness for the layout.
import React from 'react';
import { render } from 'ink-testing-library';
import { Lineage } from '../src/screens/Lineage.js';
import { SessionDetail } from '../src/screens/Session.js';
import { Diff } from '../src/screens/Diff.js';
import { Editor } from '../src/screens/Editor.js';
import { ModulePage } from '../src/screens/Module.js';

process.stdout.columns = 130;
process.stdout.rows = 50;

const noop = () => {};

const screens: Array<[string, React.ReactElement]> = [
  ['Lineage', <Lineage goto={noop} />],
  ['Session', <SessionDetail goto={noop} />],
  ['Diff', <Diff goto={noop} />],
  ['Editor', <Editor goto={noop} />],
  ['Module', <ModulePage goto={noop} />],
];

for (const [name, el] of screens) {
  console.log('\n\n======================================================================');
  console.log(`SCREEN: ${name}`);
  console.log('======================================================================');
  const { lastFrame, unmount } = render(el);
  console.log(lastFrame());
  unmount();
}
