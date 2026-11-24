// Closes Genkit apps left running in the background (e.g. after Ctrl+C on `npm run dev` on Windows).
import { cleanupRuntimes } from './runtimes.js';
const closed = cleanupRuntimes();
if (!closed.length) console.log('No leftover Genkit apps found.');
