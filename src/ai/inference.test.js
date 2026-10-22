const brain = require('brain.js');
const { runNetwork, validateNetwork, outputLabels } = require('./inference');
const { generateDataset } = require('./dataset');
const artifact = require('./model/rc-brain-1.json');

describe('RC-Brain inference', () => {
  it('reproduces brain.js outputs for the shipped weights', () => {
    const brainNet = new brain.NeuralNetwork({ hiddenLayers: artifact.hiddenLayers.diagnosis });
    brainNet.fromJSON(artifact.nets.diagnosis);
    const { holdout } = generateDataset();
    for (const row of holdout.slice(0, 12)) {
      const expected = brainNet.run(row.features);
      const actual = runNetwork(artifact.nets.diagnosis, row.features, 'diagnosis');
      for (const [label, value] of Object.entries(expected)) {
        // brain.js accumulates in float32; the same computation differs only at
        // the last few bits.
        expect(Math.abs(value - actual[label])).toBeLessThan(1e-6);
      }
    }
  });

  it('reproduces the action head too', () => {
    const brainNet = new brain.NeuralNetwork({ hiddenLayers: artifact.hiddenLayers.action });
    brainNet.fromJSON(artifact.nets.action);
    const labels = outputLabels(artifact.nets.action);
    const { holdout } = generateDataset();
    const row = holdout[0];
    const input = [...row.features, ...artifact.labels.diagnosis.map((label) => (label === row.diagnosis ? 1 : 0))];
    const expected = brainNet.run(input);
    const actual = runNetwork(artifact.nets.action, input, 'action');
    expect(labels).toEqual(expect.arrayContaining(artifact.labels.action));
    for (const [label, value] of Object.entries(expected)) {
      expect(Math.abs(value - actual[label])).toBeLessThan(1e-6);
    }
  });

  it('rejects malformed networks and wrong input widths', () => {
    expect(() => validateNetwork({ layers: [] })).toThrow(/no layers/);
    expect(() => validateNetwork({
      sizes: [2, 2],
      layers: [{}, { weights: [[1, 2]], biases: [0] }],
    })).toThrow(/wrong number of neurons/);
    expect(() => runNetwork(artifact.nets.diagnosis, [0, 1], 'diagnosis')).toThrow(/expected 44 inputs/);
  });
});
