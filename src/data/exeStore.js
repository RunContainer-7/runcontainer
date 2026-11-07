// The EXE Store catalogue.
//
// What this file is: a list of Windows programs a person can add to RunContainer in one
// press. It is data, not a service: nothing here is uploaded, ranked or fetched from a
// server, and the store works with no network of RunContainer's own.
//
// Two rules, both learned the hard way:
//
//   1. `installerUrl` is only filled in for a link that was actually fetched and answered
//      with a Windows installer. Guessed "latest" paths are how a store ships buttons
//      that 404 for every user; when this was first drafted, four of five guesses were
//      dead. An entry without a verified link gets `downloadPage` instead, and the store
//      opens the vendor's own page rather than pretending it can download it.
//   2. Nothing is bundled. RunContainer never redistributes someone else's installer;
//      it downloads from the publisher, exactly as the Sources tab does.
//
// Adding an entry: fill in every field, verify the link, and run the tests — they reject
// http links, duplicate ids, and an `installerUrl` that is not an .exe.

export const EXE_STORE = [
  {
    id: 'firefox',
    name: 'Firefox',
    publisher: 'Mozilla',
    summary: 'Web browser from Mozilla, with its own profile inside its environment.',
    category: 'Browsers',
    license: 'Free / open source',
    approxSizeMb: 60,
    glyph: 'FF',
    installNote: 'Downloads the current Windows installer from Mozilla.',
    // Verified direct link. The address has no .exe suffix because Mozilla redirects it to
    // the current installer, so a file-extension check is not how this is recognised.
    directInstall: true,
    installerUrl: 'https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US',
    downloadPage: 'https://www.mozilla.org/firefox/windows/',
  },
  {
    id: 'seven-zip',
    name: '7-Zip',
    publisher: 'Igor Pavlov',
    summary: 'Archive manager for .7z, .zip, .rar and most other compressed formats.',
    category: 'Utilities',
    license: 'LGPL / free',
    approxSizeMb: 2,
    glyph: '7z',
    installNote: 'Downloads the 64-bit installer from 7-zip.org.',
    directInstall: true,
    // Version-pinned on purpose: 7-zip.org has no "latest" path, and a pinned link that
    // works is better than a guess that does not.
    installerUrl: 'https://www.7-zip.org/a/7z2501-x64.exe',
    downloadPage: 'https://www.7-zip.org/download.html',
  },
  {
    id: 'notepad-plus-plus',
    name: 'Notepad++',
    publisher: 'Don Ho',
    summary: 'Text and source-code editor with syntax highlighting and plugins.',
    category: 'Editors',
    license: 'GPL-3.0',
    approxSizeMb: 6,
    glyph: 'N+',
    installNote: 'The release file name changes with every version, so this entry opens the official downloads page.',
    installerUrl: null,
    downloadPage: 'https://notepad-plus-plus.org/downloads/',
  },
  {
    id: 'vlc',
    name: 'VLC media player',
    publisher: 'VideoLAN',
    summary: 'Plays almost any audio or video file without extra codec packs.',
    category: 'Media',
    license: 'GPL-2.0',
    approxSizeMb: 42,
    glyph: 'VLC',
    installNote: 'VideoLAN redirects downloads to a mirror, so this entry opens the official page rather than a link that may change host.',
    installerUrl: null,
    downloadPage: 'https://www.videolan.org/vlc/download-windows.html',
  },
  {
    id: 'git-for-windows',
    name: 'Git for Windows',
    publisher: 'Git project',
    summary: 'Git, Bash and the command-line tools Windows development usually needs.',
    category: 'Development',
    license: 'GPL-2.0',
    approxSizeMb: 65,
    glyph: 'Git',
    installNote: 'The installer file name carries the version, so this entry opens the official page.',
    installerUrl: null,
    downloadPage: 'https://git-scm.com/download/win',
  },
  {
    id: 'sharex',
    name: 'ShareX',
    publisher: 'ShareX team',
    summary: 'Screen capture, recording and quick upload, with its settings kept in its own folder.',
    category: 'Utilities',
    license: 'GPL-3.0',
    approxSizeMb: 12,
    glyph: 'SX',
    installNote: 'Opens the official download page; the installer is chosen there.',
    installerUrl: null,
    downloadPage: 'https://getsharex.com/downloads',
  },
];

// A one-press install needs a link that is already an installer. Anything else must go
// through the vendor's page, and the interface says so instead of failing on a click.
// One-press install means: a link that was verified, over https. The file name proves
// nothing here — Mozilla's link redirects to the installer and has no .exe in it — so an
// entry declares that its link was checked instead of the checker guessing from a suffix.
export function isDirectInstall(entry) {
  return Boolean(entry?.directInstall && entry?.installerUrl) && /^https:\/\//i.test(entry.installerUrl);
}

export function storeEntryById(id) {
  return EXE_STORE.find((entry) => entry.id === id) || null;
}

export function storeCategories() {
  return ['All', ...new Set(EXE_STORE.map((entry) => entry.category))];
}
