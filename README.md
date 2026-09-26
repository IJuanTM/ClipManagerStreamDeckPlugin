# Clip Manager for Stream Deck

Stream Deck keys for the [Clip Manager](https://github.com/IJuanTM/ClipManager) OBS script. Each key runs one of the script's actions and shows its current state live, so you can see at a glance whether game clipping, desktop capture, your mic and mic monitoring are on.

---

## Keys

| Key             | Press                                      | Shows                                                        |
| --------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Game clipping   | Toggle game clipping for the foreground game | _Game off_, _Connecting_ (spinning ring) while OBS hooks the game, _Game on_ once it's capturing |
| Desktop capture | Toggle the desktop capture override        | _Desktop on_ / _Desktop off_                                 |
| Mic             | Mute or unmute the Clip Manager mic source | _Mic on_ / _Mic off_                                         |
| Listen          | Toggle mic monitoring (hearing yourself)   | _Listen on_ / _Listen off_                                   |
| Save replay     | Save the replay buffer                     | _Save replay_ while the buffer runs, _Replay off_ when it doesn't; flashes _Saved_ or _Failed_ |

Keys use the same icons and colours as the script's popups. They also show when something is wrong: _OBS offline_ (OBS isn't running), _WS disabled_ (OBS's WebSocket server is off), or _No source_ (the source the script is set to isn't in the current scene).

State comes from OBS itself, so the keys stay correct no matter what changed it — a key press, a hotkey, the script's automatic game detection, or a click in OBS.

---

## Requirements

- Windows, Stream Deck software 6.5 or newer
- OBS Studio 28 or newer (ships obs-websocket 5)
- The [Clip Manager](https://github.com/IJuanTM/ClipManager) script loaded in OBS

---

## Installation

1. Download the latest `.streamDeckPlugin` from [Releases](../../releases) and double-click it.
2. In OBS, open **Tools → WebSocket Server Settings** and tick **Enable WebSocket server**. Leave authentication on — the plugin reads the port and password from OBS's own config, so there's nothing to enter.
3. Drag the keys from the **Clip Manager** category onto your Stream Deck.

No hotkey bindings are needed; the keys call the script's actions directly.

---

## How it works

The plugin connects to OBS over obs-websocket and:

- **Presses** trigger the script's own hotkey actions by name (`TriggerHotkeyByName`), so everything goes through the script's logic and popups. Save replay uses OBS's `SaveReplayBuffer`.
- **State** is read from OBS once a second and on every relevant OBS event: the scene visibility of the script's game and display capture sources (plus whether the game source has a picture yet), the mic's mute and monitoring type, and whether the replay buffer is running.
- **Source names** are read from the script's saved settings, so the keys follow the same sources the script toggles. If they can't be read, the first Game Capture, Display Capture and audio input source is used.

---

## Troubleshooting

- **Every key says _WS disabled_** — enable the WebSocket server in OBS (step 2 above). The keys pick it up within a few seconds.
- **Every key says _OBS offline_ with OBS running** — check the plugin log at `%APPDATA%\Elgato\StreamDeck\logs\com.ijuantm.clipmanager0.log`. A password rejection is logged there.
- **A key says _No source_** — the script's source for that key isn't in the scene OBS is showing. Check the script's **Sources** settings.
- **A press does nothing** — the Clip Manager script isn't loaded, so its actions don't exist. The key shows a warning triangle.

---

## Development

- `com.ijuantm.clipmanager.sdPlugin/` is the plugin itself: plain Node.js with no dependencies (Stream Deck runs it on its bundled Node 20, which has no WebSocket client, so `bin/ws.js` implements one).
- Key images are rendered from the Clip Manager script's `icons/` with `python tools/render_images.py` (needs Pillow, and the ClipManager repo checked out next to this one). Re-run it after changing an icon or the key design.
- To try a change, copy the `.sdPlugin` folder into `%APPDATA%\Elgato\StreamDeck\Plugins\` and restart Stream Deck.
- Releases build automatically: bump `Version` in `manifest.json` (e.g. `1.1.0`) and push to `master`.
