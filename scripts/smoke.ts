// Boots the Genkit app without calling Gemini and lists what `genkit eval:flow` will see.
process.env.GEMINI_API_KEY ??= 'smoke-test-key';
const { ai } = await import('../src/index.js');
const actions = Object.keys(await ai.registry.listActions()).filter((k) => /flow|evaluator|retriever/.test(k));
console.log(actions.sort().join('\n'));
