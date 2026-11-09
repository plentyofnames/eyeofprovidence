// WebMIDI transport, after Lilypad's midi.js. Nothing is requested or sent until the user
// presses Connect (or Read EC4).

let access = null;

export async function midiAccess() {
  if (access) return access;
  if (!globalThis.navigator?.requestMIDIAccess) throw new Error('No WebMIDI in this browser (use Chrome).');
  access = await navigator.requestMIDIAccess({ sysex: true });
  return access;
}

export const BCR32_NAME = /bcr-?32/i;
export const EC4_NAME = /faderfox ec4|\bec4\b/i;

// Inputs and outputs paired by name, the ones matching `prefer` first.
export function portPairs(acc, prefer = BCR32_NAME) {
  const ins = [...acc.inputs.values()];
  const outs = [...acc.outputs.values()];
  const live = (p) => p.state !== 'disconnected';
  const pairs = outs.filter(live).map((o) => ({ name: o.name, out: o, in: ins.find((i) => i.name === o.name && live(i)) || null }));
  pairs.sort((a, b) => Number(prefer.test(b.name)) - Number(prefer.test(a.name)));
  return pairs.filter((p) => p.in);
}

export function midiTransport(input, output) {
  const port = {
    name: output.name,
    output, // its .state tells when the unit is unplugged
    onmessage: null,
    ondisconnect: null, // the unit went away (unplugged): set by the app
    send(bytes) {
      output.send(bytes);
    },
    close() {
      input.onmidimessage = null;
      input.onstatechange = null;
      output.onstatechange = null;
    },
  };
  input.onmidimessage = (e) => port.onmessage?.(e.data);
  // Unplugging is noticed at once, not at the next Send (review, 2026-11-08; as Lilypad)
  const gone = (e) => e.port?.state === 'disconnected' && port.ondisconnect?.();
  input.onstatechange = gone;
  output.onstatechange = gone;
  return port;
}

// 'granted', 'prompt', 'denied' or 'unknown' (no Permissions API for MIDI).
export async function midiPermission() {
  try {
    return (await navigator.permissions.query({ name: 'midi', sysex: true })).state;
  } catch {
    return 'unknown';
  }
}
