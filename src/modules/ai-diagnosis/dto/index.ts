// The live contract. AnalyzeDto and AskDto are what the routes accept, and the
// interfaces mirror what the AI Service returns.
export * from './ai-contract.dto';

// Kept for anything still importing them. These describe a response shape the
// AI Service does not produce: `possibleProblems`, `estimatedCost` and
// `suggestedActions` were never fields of its API, which is how this module
// ended up mapping real answers onto defaults. Do not write new code against
// them.
export * from './diagnosis-request.dto';
export * from './diagnosis-response.dto';
