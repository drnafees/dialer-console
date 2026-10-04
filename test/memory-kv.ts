// Just enough of the KVNamespace surface for the functions/_lib code under test.

export class MemoryKV {
  private readonly data = new Map<string, string>();
  reads = 0;
  writes = 0;

  async get(key: string): Promise<string | null> {
    this.reads++;
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.writes++;
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(): Promise<{ keys: { name: string }[]; list_complete: true; cursor?: string }> {
    return { keys: [...this.data.keys()].map((name) => ({ name })), list_complete: true };
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
}

// Only the subset above is implemented; cast at the boundary.
export const asKv = (kv: MemoryKV) => kv as unknown as KVNamespace;
