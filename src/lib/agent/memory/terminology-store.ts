import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';

export interface Term {
    source: string;
    target: string;
    category?: string;
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

        const lowerText = text.toLowerCase();
        const foundTerms: Term[] = [];

        // Simple substring match for now. 
        // Optimization: Could use Aho-Corasick or Regex if performance becomes an issue.
        for (const term of this.terms) {
            if (lowerText.includes(term.source.toLowerCase())) {
                foundTerms.push(term);
            }
        }

        // Deduplicate by source (prefer longer matches or specific categories? 
        // For now just return all unique matches)
        return Array.from(new Set(foundTerms));
    }

    getTerms(): Term[] {
        return this.terms;
    }
}

// Singleton instance for the application
const TERMS_DIR = path.join(process.cwd(), 'terms');
export const terminologyStore = new TerminologyStore(TERMS_DIR);
