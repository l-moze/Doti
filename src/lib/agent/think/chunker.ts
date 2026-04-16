
export interface Chunk {
    id: string; // unique identifier (e.g., index)
    content: string;
    type: 'text' | 'references';
    metadata: {
        startIndex: number;
        endIndex: number;
        title?: string; // Potential section title
    };
}

const REFERENCE_KEYWORDS = ['reference', 'references', 'bibliography', '参考文献'];

export class Chunker {
    // Threshold for splitting large sections (approx 5000 chars)
    private readonly MAX_CHUNK_SIZE = 5000;

    private createChunkId(prefix: 'chunk' | 'subchunk', startIndex: number, sequence: number): string {
        return `${prefix}-${startIndex}-${sequence}`;
    }

    clean(text: string): string {
        // Basic hyphenation fix: "ex- \n ample" -> "example"
        // Be careful not to break code blocks. Ideally, validation should be done, 
        // but for now, we use a conservative regex.
        // This looks for: word ending in hyphen, optional whitespace/newlines, next word start
        return text.replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2');
    }

    split(markdown: string): Chunk[] {
        const cleanedText = this.clean(markdown);
        return this.robustSplit(cleanedText);
    }

    private robustSplit(text: string): Chunk[] {
        const lines = text.split('\n');
        const chunks: Chunk[] = [];

        let currentBuffer: string[] = [];
        let currentTitle = "Start";
        let bufferStartIndex = 0;

        const flushBuffer = () => {
            if (currentBuffer.length === 0) return;

            const sectionContent = currentBuffer.join('\n');
            const isRef = this.isReferenceSection(currentTitle);

            // Check size. If too big, split by paragraph
            if (sectionContent.length > this.MAX_CHUNK_SIZE && !isRef) {
                const subChunks = this.splitByParagraph(sectionContent, currentTitle, bufferStartIndex);
                chunks.push(...subChunks);
            } else {
                chunks.push({
                    id: this.createChunkId('chunk', bufferStartIndex, chunks.length),
                    content: sectionContent,
                    type: isRef ? 'references' : 'text',
                    metadata: {
                        startIndex: bufferStartIndex,
                        endIndex: bufferStartIndex + sectionContent.length,
                        title: currentTitle
                    }
                });
            }

            currentBuffer = [];
            // Update bufferStartIndex (approximation since we joined by \n)
            // Ideally we should track exact char indices but for translation flow, 
            // approximations are usually okay as long as we don't lose content.
            // But to be precise, let's just accumulate content length.
        };

        let runningCharCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isHeader = line.match(/^#{1,2}\s+(.+)/);

            if (isHeader) {
                // Determine if we should split here
                // If the buffer is not empty, this starts a new section, so flush the old one.
                if (currentBuffer.length > 0) {
                    flushBuffer();
                    bufferStartIndex = runningCharCount; // Start of this new header
                }

                // Set the new title
                currentTitle = isHeader[1].trim();
            }

            currentBuffer.push(line);
            runningCharCount += line.length + 1; // +1 for newline
        }

        // Flush remaining
        if (currentBuffer.length > 0) {
            flushBuffer();
        }

        return chunks;
    }

    private splitByParagraph(text: string, title: string, startIndex: number): Chunk[] {
        // Simple splitting by double newline to detect paragraphs
        const paragraphs = text.split(/\n\s*\n/);
        const subChunks: Chunk[] = [];

        let currentSubBuffer = "";
        let currentSubStart = startIndex;

        for (const para of paragraphs) {
            // Re-add the split delimiter we lost? split consumes it.
            // We assume \n\n
            const paraText = para + "\n\n";

            if ((currentSubBuffer.length + paraText.length) > this.MAX_CHUNK_SIZE) {
                // Push current buffer
                if (currentSubBuffer.trim().length > 0) {
                    subChunks.push({
                        id: this.createChunkId('subchunk', startIndex, subChunks.length),
                        content: currentSubBuffer,
                        type: 'text',
                        metadata: {
                            startIndex: currentSubStart,
                            endIndex: currentSubStart + currentSubBuffer.length,
                            title: title + " (cont.)"
                        }
                    });
                    currentSubStart += currentSubBuffer.length;
                    currentSubBuffer = "";
                }
            }

            currentSubBuffer += paraText;
        }

        if (currentSubBuffer.trim().length > 0) {
            subChunks.push({
                id: this.createChunkId('subchunk', startIndex, subChunks.length),
                content: currentSubBuffer,
                type: 'text',
                metadata: {
                    startIndex: currentSubStart,
                    endIndex: currentSubStart + currentSubBuffer.length,
                    title: title + " (cont.)"
                }
            });
        }

        return subChunks;
    }

    private isReferenceSection(title: string): boolean {
        const lower = title.toLowerCase();
        return REFERENCE_KEYWORDS.some(kw => lower.includes(kw));
    }
}
