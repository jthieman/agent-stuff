import { InMemoryFs, type InitialFiles } from "just-bash";

export class MemoryJustBashFs extends InMemoryFs {
  constructor(entries: InitialFiles = {}) {
    super(entries);
    this.mkdirSync("/workspace", { recursive: true });
    this.mkdirSync("/tmp", { recursive: true });
  }
}
