import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';

export interface Term {
    source: string;
    target: string;
    category?: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordLikeCharacter(value: string | undefined): boolean {
    return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function createTermMatcher(source: string): RegExp {
    const trimmedSource = source.trim();
    const prefix = isWordLikeCharacter(trimmedSource[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
    const suffix = isWordLikeCharacter(trimmedSource.at(-1)) ? "(?![\\p{L}\\p{N}_])" : "";
    return new RegExp(`${prefix}${escapeRegExp(trimmedSource)}${suffix}`, "iu");
}

export class TerminologyStore {
    private terms: Term[] = [];
    private isLoaded: boolean = false;
    private termsDir: string;

    constructor(termsDir: string) {
        this.termsDir = termsDir;
    }

    /**
     * Loads all CSV files from the terms directory.
     * Caches the results in memory.
     */
    async load(): Promise<void> {
        if (this.isLoaded) return;

        try {
            const files = await fs.readdir(this.termsDir);
            const csvFiles = files.filter(f => f.endsWith('.csv'));

            for (const file of csvFiles) {
                const filePath = path.join(this.termsDir, file);
                const fileContent = await fs.readFile(filePath, 'utf-8');

                // Parse CSV - assumes no header or header handled by caller, 
                // but based on user file 'default.csv' it seems to be just data: "English,Chinese"
                // 'default.csv' line 1: Artificial General Intelligence,通用人工智能
                const records = parse(fileContent, {
                    columns: ['source', 'target'],
                    skip_empty_lines: true,
                    trim: true,
                    relax_column_count: true
                });

                // Add category based on filename (e.g. 'cs.AI.csv' -> 'cs.AI')
                const category = path.parse(file).name;

                for (const record of records as Array<{ source?: string; target?: string }>) {
                    if (record.source && record.target) {
                        this.terms.push({
                            source: record.source,
                            target: record.target,
                            category
                        });
                    }
                }
            }

            console.log(`[TerminologyStore] Loaded ${this.terms.length} terms from ${csvFiles.length} files.`);
            this.isLoaded = true;
        } catch (error) {
            console.error("[TerminologyStore] Failed to load terms:", error);
            // Don't crash, just start with empty terms
            this.terms = [];
        }
    }

    /**
     * Retrieves terms that appear in the given text.
     * Case-insensitive matching.
     */
    findTerms(text: string): Term[] {
        if (!text) return [];

        const foundTerms = this.terms
            .filter((term) => term.source.trim() && createTermMatcher(term.source).test(text))
            .sort((left, right) => right.source.length - left.source.length);

        const seen = new Set<string>();
        const result: Term[] = [];

        for (const term of foundTerms) {
            const key = `${term.source.toLowerCase()}::${term.target.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(term);
        }

        return result;
    }

    getTerms(): Term[] {
        return this.terms;
    }
}

// Singleton instance for the application
const TERMS_DIR = path.join(process.cwd(), 'terms');
export const terminologyStore = new TerminologyStore(TERMS_DIR);
