import fs from 'fs';
import path from 'path';

export class FeatureLogger {
  private stream: fs.WriteStream | null = null;
  constructor(private filePath: string) {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  log(obj: Record<string, unknown>): void {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      // swallow to avoid blocking trading loop
    }
  }

  close(): void {
    try {
      this.stream?.end();
    } catch {}
  }
}
