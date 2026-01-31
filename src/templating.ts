import { Liquid } from 'liquidjs';
import { Notice } from 'obsidian';

export class TemplatingService {
    private engine: Liquid;

    constructor() {
        this.engine = new Liquid({
            strictFilters: false, // Don't crash on missing filters
            strictVariables: false, // Don't crash on missing variables
        });

        this.registerCustomFilters();
    }

    private registerCustomFilters() {
        // Register BookFusion-like filters to maximize compatibility

        // tagify: "My Tag" -> "#My-Tag" (or just "My-Tag" if we want to prepend # later, but usually tagify implies hashtag)
        // BookFusion example: "{% for tag in tags %} {{ tag | tagify }}{% endfor %}" -> implies it outputs "#tag"
        this.engine.registerFilter('tagify', (initial: string) => {
            if (!initial) return '';
            const tag = initial.toString().trim().replace(/\s+/g, '-').replace(/[^\w\-]/g, '');
            return `#${tag}`;
        });

        // bookshelf_path: "Shelf A" -> "BookFusion/Bookshelves/Shelf A" (mock implementation)
        // We don't have a rigid structure, so we might just return the name or a default path
        this.engine.registerFilter('bookshelf_path', (name: string) => {
            return `Bookshelves/${name}`;
        });

        this.engine.registerFilter('author_path', (name: string) => {
            return `Authors/${name}`;
        });

        this.engine.registerFilter('series_path', (name: string) => {
            return `Series/${name}`;
        });

        this.engine.registerFilter('category_path', (name: string) => {
            return `Categories/${name}`;
        });

        // prepend_each_newline: Useful for blockquotes
        this.engine.registerFilter('prepend_each_newline', (str: string, prefix: string) => {
            if (!str) return '';
            return str.toString().split('\n').map(line => `${prefix}${line}`).join('\n');
        });
    }

    public async render(template: string, context: any): Promise<string> {
        try {
            return await this.engine.parseAndRender(template, context);
        } catch (e) {
            console.error("Template rendering failed", e);
            new Notice(`Template rendering failed: ${e.message}`);
            return "Error rendering template";
        }
    }

    // Pre-configured templates to match the "Default" behavior we used to have
    public static getDefaultPageTemplate(): string {
        return `---
title: "{{ title }}"
authors: 
{% for author in authors %}- "{{ author }}"
{% endfor %}
isbn: {{ isbn }}
tags: 
{% for tag in tags %}- {{ tag }}
{% endfor %}
cover: {{ cover_url }}
read_url: {{ read_url }}
progress: {{ progress }}
status: {{ status }}
uploaded_at: {{ uploaded_at }}
---

# {{ title }}

{% if cover_url %}![Cover|150]({{ cover_url }}){% endif %}

## Metadata
**Authors**: {% for author in authors %}[[{{ author }}]] {% endfor %}
**Description**: {{ description }}
**Progress**: <progress value="{{ progress }}" max="100">{{ progress }}%</progress>

## Highlights & Notes
`;
    }

    public static getDefaultHighlightTemplate(): string {
        return `%%begin-highlight-{{ uuid }}%%
**Date Created**: {{ created_at }}
{% if color %}**Color**: {{ color }} <span style="color: {{ color }};">■</span>{% endif %}
> [!quote]
{{ quote | prepend_each_newline: '> ' }}

{% if note != blank %}
> [!note]
{{ note | prepend_each_newline: '> ' }}
{% endif %}

[View highlight]({{ view_url }})
%%end-highlight-{{ uuid }}%%`;
    }
}
