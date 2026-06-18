// No-op Windows signing hook.
//
// We don't have a code-signing certificate, and the default electron-builder
// signing path downloads `winCodeSign` from GitHub during packaging — which
// fails on networks that can't reach GitHub. Pointing `win.signtoolOptions.sign`
// at this script makes electron-builder call us instead of its bundled signer,
// so nothing is downloaded and the executable is simply left unsigned.
exports.default = async function sign() {
  // Intentionally do nothing.
};
