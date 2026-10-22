// Inference for RC-Brain's serialised networks.
//
// The model was trained with brain.js, but the app does not load brain.js at
// runtime: brain.js declares gpu.js as a peer dependency, which packaging
// prunes, and a monitor must not depend on an optional GPU package to start.
// This is a plain forward pass over the same weights brain.js produced:
// sigmoid activations, one matrix per layer, output order taken from the
// network's own outputLookup. tests compare it against brain.js directly.

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function validateNetwork(network, label = 'network') {
  if (!network || !Array.isArray(network.layers) || network.layers.length < 2) {
    throw new Error(`The ${label} has no layers.`);
  }
  if (!Array.isArray(network.sizes) || network.sizes.length !== network.layers.length) {
    throw new Error(`The ${label} has inconsistent layer sizes.`);
  }
  for (let index = 1; index < network.layers.length; index += 1) {
    const layer = network.layers[index];
    if (!Array.isArray(layer?.weights) || !Array.isArray(layer?.biases)) {
      throw new Error(`The ${label} layer ${index} is missing weights or biases.`);
    }
    if (layer.weights.length !== network.sizes[index] || layer.biases.length !== network.sizes[index]) {
      throw new Error(`The ${label} layer ${index} has the wrong number of neurons.`);
    }
    if (layer.weights.some((row) => !Array.isArray(row) || row.length !== network.sizes[index - 1])) {
      throw new Error(`The ${label} layer ${index} has the wrong input width.`);
    }
  }
}

function outputLabels(network) {
  if (network.outputLookup && typeof network.outputLookup === 'object') {
    return Object.entries(network.outputLookup)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(([label]) => label);
  }
  const size = network.sizes[network.sizes.length - 1];
  return Array.from({ length: size }, (_value, index) => String(index));
}

function runNetwork(network, input, label = 'network') {
  if (!Array.isArray(input) || input.length !== network.sizes[0]) {
    throw new Error(`The ${label} expected ${network.sizes[0]} inputs, received ${Array.isArray(input) ? input.length : 0}.`);
  }
  let values = input;
  for (let index = 1; index < network.layers.length; index += 1) {
    const layer = network.layers[index];
    const next = new Array(layer.biases.length);
    for (let neuron = 0; neuron < layer.biases.length; neuron += 1) {
      const row = layer.weights[neuron];
      let sum = layer.biases[neuron];
      for (let source = 0; source < row.length; source += 1) sum += row[source] * values[source];
      next[neuron] = sigmoid(sum);
    }
    values = next;
  }
  const labels = outputLabels(network);
  if (labels.length !== values.length) {
    throw new Error(`The ${label} has ${values.length} outputs but ${labels.length} labels.`);
  }
  return Object.fromEntries(labels.map((name, index) => [name, values[index]]));
}

module.exports = {
  sigmoid,
  validateNetwork,
  outputLabels,
  runNetwork,
};
