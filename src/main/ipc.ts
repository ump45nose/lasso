export const result = async (action: () => unknown) => { try { await action(); return { error: null }; } catch (error) { return { error: (error as Error).message }; } };
