// Entry point, small on purpose: the fonts, the page's own styles and the title card. The game is a second, much
// larger script (src/boot.ts) that the page starts fetching at the same moment (vite.config.ts adds the preload),
// so the card is on screen while it arrives instead of after it.
//
// The font imports have no .css extension on purpose: the packages' export map
// adds it, and Vite fails to resolve the path when it is written out.

import '@fontsource/big-shoulders-display/latin-700';
import '@fontsource/big-shoulders-display/latin-900';
import '@fontsource/barlow-semi-condensed/latin-400';
import '@fontsource/barlow-semi-condensed/latin-500';
import '@fontsource/barlow-semi-condensed/latin-600';
import '@fontsource/ibm-plex-mono/latin-400';
import '@fontsource/ibm-plex-mono/latin-500';
import '@fontsource/ibm-plex-mono/latin-600';
import './ui/base.css';
import { title } from './ui/title';
import { cloud } from './core/cloud';

// Cloud save (core/cloud.ts, off unless the player turned it on): a newer save from another device is put into
// localStorage BEFORE the game's script reads it, so there is no second load. It waits at most 2.5 s, and not at all when off.
cloud.early().then(() => import('./boot')).catch((err: unknown) => {
  console.error(err);
  title.progress(0, 'Something sank. Reload to try again.');
});
