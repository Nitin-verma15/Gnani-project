// Runs on the browser's audio thread and hands raw microphone samples to the page.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("recorder", RecorderProcessor);
