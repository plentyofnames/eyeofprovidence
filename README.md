# Eye of Providence

A browser-based **Web MIDI editor for the controller pages of Rotary Club**, a custom firmware for the Behringer BCR32: four pages of 32 knobs and 16 keys, their names, each page's MIDI outputs, and the FH-2 sync entries [Night Shift](https://plentyofnam.es/nightshift/) makes. Derived from [Lilypad](https://plentyofnam.es/lilypad/), the EC4 editor for controlfrog.

▶︎ **Live editor:** https://plentyofnam.es/eyeofprovidence/

> **Unofficial.** Eye of Providence and Rotary Club are not made, endorsed or supported by Behringer. Behringer and BCR32 are trademarks of their owner; the FH-2 is Expert Sleepers'.
>
> **Editing a real unit needs the Rotary Club firmware (0.23 or later), which is not released yet.** The stock BCR32 firmware does not speak this protocol. Until then you can try everything against the built-in demo BCR32, and edit `.bin` images offline.

Plain HTML, CSS and JS modules: no build step, no dependencies.

## Try it

Open the [live editor](https://plentyofnam.es/eyeofprovidence/) and press **Demo BCR32** (or open it with `?demo`). The demo is a simulated BCR32 in the page, with three Night Shift pages, a TD-3 half page, a Rytm page and an empty page 4. Its panel at the bottom has the knobs (wheel or drag turns, click pushes), keys, T1–T4 and ZAQ/CTRL, and some faults to try. It remembers its stored image in your browser; **Reset demo** brings the demo back.

To run it locally, serve the folder over HTTP (modules don't load from `file://`):

```sh
python3 -m http.server 8000
```

and open <http://localhost:8000/>. After pulling a newer version, hard-reload (Cmd+Shift+R), since `http.server` sends no cache headers.

## Requirements

- **Chrome, Edge** or another browser with Web MIDI and SysEx. Safari has no Web MIDI. The browser asks for MIDI/SysEx permission once.
- For a real unit: a BCR32 running Rotary Club 0.23 or later, on USB. **BCR32 (MIDI)**: pick the port (one named like `BCR32` / `BCR-32` comes first), **Connect**. Older firmware is refused.

## Use

- **Connect** identifies the BCR32, reads the whole controller space (16 READs of 256 bytes), turns touch events on.
- **Pages 1–4** are the tabs (keys `1`–`4` too). Each page has its **name** (4 characters) and its **outputs** (USB, A, B: where the page's MIDI goes; all three = blank `FF`).
- **Knobs** are 4 rows × 8 as on the panel, **keys** 1–16 below. A box shows the name, what the knob sends, its push, `FH2` for a synced knob (red when the entry can't be used, e.g. the knob is no longer a CC or a 14-bit CC), a red dot when it differs from the BCR32. Blank cells show `off`.
- **Click** a box to edit it on the right: Turn (type, channel, number / note / NRPN, lower, upper, display, mode, link), Push (type, channel or page, number / note, key or toggle, display, lower, upper, link), the FH-2 entry (table A, B, C) with **Remove entry**, and the 15 bytes. A key has only its push and name. **Copy / Paste / Clear** a cell (⌘C / ⌘V too). Arrow keys move.
- **Several cells:** Shift-click selects a range (knobs or keys), ⌘/Ctrl-click adds or removes one, ⌘A all the page's knobs (or keys), Esc one again. The right side then sets a field on every selected cell it applies to (Turn: type, channel, lower, upper, display, mode; Push or key: type, channel, mode, lower, upper, display), and **Fill channels** / **Fill numbers** count up from the first cell's value (channels wrap after 16, CCs after 127, a 14-bit MSB after 31). **Copy** takes them all; **Paste** puts one copied cell into every selected one, several from the first selected on. One undo step each.
- **Send** writes only the changed ranges (WRITE ≤ 256 bytes each, each reply checked), then RELOAD: the BCR32 uses and stores them. Until RELOAD answers nothing counts as stored: a Cancel or an error leaves the written bytes "to send" (a Read meanwhile keeps the stored bytes as their baseline, so they stay to send), and the next Send writes what is left and RELOADs. When the BCR32 could not store the image (`7F 24 04`: no store, a flash error) it plays it until power-off and the editor says so; it stays to send. After RELOAD one GET_STATE more makes sure the answer was RELOAD's own (a T key on the unit sends a STATE too). An edit made while a Send runs stays yours and is kept by a Read. **Read** reads the BCR32 again; your edits stay (only the bytes you changed here, or a whole opened file). **Discard** goes back to what the BCR32 holds (undoable). **As connected** goes back to the image the BCR32 had when you connected, as an edit: Send puts it back on the unit, ⌘Z undoes it. **⌘Z / ⇧⌘Z** undo and redo everything.
- **Follow**: turning or pushing a knob or pressing a key on the BCR32 selects it here; T1–T4 on the BCR32 switch the tab (in controller mode).
- **Play edits**: while you edit, the page the BCR32 shows plays your cells right away (EDIT, RAM only), before Send. Dropped when the BCR32 loads another page; sent again then. Switching Play edits off, or disconnecting, puts the stored cells back (by EDIT), so nothing unsent keeps playing. A T tap or Show on BCR32 for the page already in view changes nothing (firmware 0.24).
- **Save** writes the 4 KB image as a `.bin` backup; **Open** (or drop a file) loads one. Its bytes become changes to send.
- **Log** in the status bar shows the protocol messages.
- Unplugging the BCR32 disconnects at once; unsent edits stay.

**The FH-2 sync:** any controller command (Connect reads space 2) switches the BCR32's FH-2 sync off until its USB goes down (controlfrog: until power-off). Moving the cable from the Mac to the FH-2 brings it back.

## Import Night Shift's pages

Night Shift writes its FH-2 pages into an EC4's setup 15. **Import** copies them onto the BCR32's pages, two EC4 groups side by side on one page: EC4 group 1 → page 1 left, group 2 → page 1 right, group 3 → page 2 left …, with each knob's table A, B and C entries and the sync header (byte 4 = 0).

1. **Import** (top right).
2. Either **Read EC4**: the EC4 running controlfrog on its MIDI port (pick it in the list; Lilypad and Night Shift's EC4 link must not be connected meanwhile, only one host at a time). It reads setup 15's groups 1–8 and the tables (~1.5 s), nothing is written to the EC4. Or **Open .syx**: a Lilypad full EEPROM dump (with the tables) or an "all setups" file (cells only). **Demo EC4** reads a simulated one.
3. The groups found are listed; the ones with pages are ticked. **Import N groups** replaces those half pages (and the FH-2 header) in the editor; the other knobs stay. Imported knobs are outlined until **Hide marks**. ⌘Z undoes it.
4. **Send**.

## Tests

```
deno run --allow-read test/run.js      # or: node test/run.js
```

or `test/` in the browser (on the live site: https://plentyofnam.es/eyeofprovidence/test/). 43 tests: framing (pack, unpack, checksum, frames), the cell record round trip and clamps, a key's dropped push types, outputs, sync entries, the EC4 → BCR32 mapping (cells and tables), the import from a fake EC4 over Lilypad's device code (controlfrog 0.13 and 0.12) and from `.syx` files, Night Shift's free knobs as blank cells, reads and chunked writes against the mock, a RELOAD the BCR32 could not store, the Read after a Send that failed after a WRITE, WRITE errors, busy retries, touch and state events, EDIT, the live link (EDIT for the page in view, again after a page change, back on drop, nothing with Play edits off), bulk editing (a field on several cells, fill, copy and paste of several), History's merging, an edit made during a Send, a band entry the firmware ignores.

## Files

`js/app.js` the UI · `js/model.js` the 4 KB image, the cell record, rules, sync tables · `js/proto.js` framing and messages · `js/device.js` the host client · `js/mock.js` the demo BCR32 · `js/store.js` the image and the BCR32's copy, diff chunks · `js/import.js` Night Shift's EC4 pages → BCR32 · `js/demo.js` the demo images · `js/midi.js` WebMIDI · `js/live.js` the live link (Play edits) · `js/bulk.js` several cells at once (after Lilypad's) · `js/history.js` Lilypad's · `js/dom.js` Lilypad's at e1f3d8b, without its popup · `js/ec4/` Lilypad's EC4 code byte for byte as Lilypad e1f3d8b (protocol, device, model, `.syx`, mock): copy them over again to re-sync.

## Choices made here

- **Mode** values above 9 count as Acc2, as Rotary Club does (controlfrog's firmware loads them as Acc3, Lilypad's model as Acc0). **Display** (scale) values above 8 show as 0–127, as controlfrog's loader.
- **A 14-bit CC (the EC4's CCAh) is always 14-bit**, as on controlfrog; PBnd and NRPN only with the scales off / 1000 / ±500 / 9999. Lower and upper are 12-bit (0–4094, or 16383).
- **Link** isn't offered on knob 32 or key 16 (there is no next one); a key's push links to the next key.
- **Keys** show Set and the encoder push types (Acc0, Acc3, LSp6, Min, Max) greyed out: a key has no encoder, and the firmware plays such a key as off (the spec says so); a key stored with one shows "off" and a note. A Grp push picks page 1–4. Set is listed but does nothing.
- **Names** take any printable ASCII (`20`–`7E`), as Rotary Club shows them (the EC4 took fewer).
- **Switching a blank cell on:** knob → channel 1, CC 20 + knob number − 1 (a 14-bit CC: 1–31, the whole 0–16383), Acc1, display 0–127, push off; a knob's push switched on → CC 64 + knob number − 1 (clear of the knob's own CC and of the 14-bit LSBs 33–63), channel 1, key mode; key → Note 36 + key − 1, channel 1, key mode, note off at velocity 64, LED display on. Switching between 7 and 14 bits keeps the ends (127 ↔ 16383).
- The header (`BCRC` 01) is written with the first edit of a blank image.
- **Import:** a page's name comes from its left group (or the right one when only that is imported); imported pages get outputs `FF` (all, so the FH-2 on USB hears them). Night Shift's free knobs (CC 119 relative on the pages channel, Acc0, display off, no name, no push, no entry: the EC4 has no "off") become blank cells. Groups with no name, no named knob, no push and no entry count as empty and aren't ticked. From an "all setups" `.syx` (no tables) the imported knobs' entries are cleared and the header is kept. Table C is copied only from controlfrog 0.13 on (from a device). The header is copied as it is (byte 4 = 0); a format-1 table is warned about, not converted.
- **Play edits** sends EDIT for keys as cells 32–47 (as TEXT counts them), only for the page the BCR32 reports. The firmware answers `7F 2C 06` to an EDIT for another page (0.27 on; `01` before; controlfrog ignores it): the editor asks GET_STATE, and the page's STATE sends the edits again. Edits are measured against what the controller last loaded (RELOAD, power-on), not against what a Send wrote into its RAM since.
- **Follow** switches tabs only in controller mode (mode 1), and never while a name box, number box or list anywhere in the page has the focus.
- WRITE ranges join across up to 8 unchanged bytes; reserved bytes are never written. RELOAD gets 5 s (it writes the store). A busy reply (`7F cmd 03`, rcproto.h) is tried again after 20 ms.
- Connecting keeps edits made before (a file, an import, offline edits) as changes to send; Discard takes the BCR32's.

## Not done

- Not tried on hardware: a BCR32 with 0.27, and the EC4 import over real MIDI (both only against mocks). Port names are matched by `/bcr-?32/i` and `/faderfox ec4|ec4/i`.
- TEXT (value texts) isn't sent; that's Night Shift's live link.
- Creating FH-2 entries (Night Shift makes them); copying whole pages; Lilypad's replug reconnect and one-tab-per-unit coordination.
- JSON backups (`.bin` only).
