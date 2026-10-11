import {css} from '@codemirror/lang-css';
import {html} from '@codemirror/lang-html';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {EditorState, type Extension} from '@codemirror/state';
import {oneDark} from '@codemirror/theme-one-dark';
import {EditorView, basicSetup} from 'codemirror';

function language(path: string): Extension {
    if (/\.[cm]?[jt]sx?$/.test(path)) return javascript({typescript: /\.[cm]?tsx?$/.test(path), jsx: /x$/.test(path)});
    if (/\.html?$/.test(path)) return html();
    if (path.endsWith('.css')) return css();
    if (/\.(json|geojson)$/.test(path)) return json();
    return [];
}

/** A CodeMirror editor for one file. `onChange` gets the text after each edit by the user. */
export function createEditor(parent: HTMLElement, path: string, doc: string, onChange: (text: string) => void): EditorView {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                basicSetup,
                language(path),
                dark ? oneDark : [],
                EditorView.theme({'&': {height: '100%', fontSize: '12px'}, '.cm-scroller': {overflow: 'auto'}}),
                EditorView.updateListener.of(update => {
                    if (update.docChanged) onChange(update.state.doc.toString());
                }),
            ],
        }),
    });
}
