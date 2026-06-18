export class ThinkingTagStripper {
    private inThinking = false;
    private buffer = "";

    consume(chunk: string, flush = false): string {
        this.buffer += chunk;
        let output = "";

        while (this.buffer.length > 0) {
            if (!this.inThinking) {
                const openIdx1 = this.buffer.indexOf('<think>');
                const openIdx2 = this.buffer.indexOf('<thinking>');
                let openIdx = openIdx1;
                if (openIdx === -1 || (openIdx2 !== -1 && openIdx2 < openIdx1)) {
                    openIdx = openIdx2;
                }

                if (openIdx !== -1) {
                    // Start of thinking found
                    output += this.buffer.slice(0, openIdx);
                    this.buffer = this.buffer.slice(openIdx);
                    this.inThinking = true;
                } else {
                    // No full open tag found. Wait if we might be forming one.
                    const maxPrefixLen = 10;
                    let safeIdx = this.buffer.length;
                    for (let i = Math.max(0, this.buffer.length - maxPrefixLen); i < this.buffer.length; i++) {
                        if (this.buffer[i] === '<') {
                            safeIdx = i;
                            break;
                        }
                    }
                    if (flush) {
                        output += this.buffer;
                        this.buffer = "";
                    } else {
                        output += this.buffer.slice(0, safeIdx);
                        this.buffer = this.buffer.slice(safeIdx);
                    }
                    break;
                }
            } else {
                // In thinking mode
                const closeIdx1 = this.buffer.indexOf('</think>');
                const closeIdx2 = this.buffer.indexOf('</thinking>');
                let closeIdx = closeIdx1;
                let closeLen = 8; // length of </think>
                if (closeIdx === -1 || (closeIdx2 !== -1 && closeIdx2 < closeIdx1)) {
                    closeIdx = closeIdx2;
                    closeLen = 11; // length of </thinking>
                }

                if (closeIdx !== -1) {
                    // End of thinking found
                    this.buffer = this.buffer.slice(closeIdx + closeLen);
                    // Optionally strip leading newlines immediately after </think> 
                    // since models often output \n\n after thinking.
                    while (this.buffer.startsWith('\n') || this.buffer.startsWith('\r')) {
                        this.buffer = this.buffer.slice(1);
                    }
                    this.inThinking = false;
                } else {
                    // No full close tag found. Wait if we might be forming one.
                    let safeIdx = this.buffer.length;
                    for (let i = Math.max(0, this.buffer.length - 11); i < this.buffer.length; i++) {
                        if (this.buffer[i] === '<') {
                            safeIdx = i;
                            break;
                        }
                    }
                    if (flush) {
                        this.buffer = "";
                    } else {
                        this.buffer = this.buffer.slice(safeIdx);
                    }
                    break;
                }
            }
        }
        return output;
    }
}
