import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { useEffect } from 'react';

type Props = {
  html: string;
  onChange: (html: string) => void;
  onImageUpload?: (file: File) => Promise<string | null>;
  placeholder?: string;
};

export function EmailRichEditor({ html, onChange, onImageUpload, placeholder = 'Write your message…' }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      Underline,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder }),
      Image.configure({ inline: true, allowBase64: false }),
    ],
    content: html || '',
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'eml-editor-prose',
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (html !== current && html !== undefined) {
      editor.commands.setContent(html || '', { emitUpdate: false });
    }
  }, [html, editor]);

  if (!editor) return null;

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', prev || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const insertImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !onImageUpload) return;
      const url = await onImageUpload(file);
      if (url) editor.chain().focus().setImage({ src: url }).run();
    };
    input.click();
  };

  return (
    <div className="eml-editor-wrap">
      <div className="eml-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" className={editor.isActive('bold') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
          <strong>B</strong>
        </button>
        <button type="button" className={editor.isActive('italic') ? 'on' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
          <em>I</em>
        </button>
        <button type="button" className={editor.isActive('underline') ? 'on' : ''} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
          <u>U</u>
        </button>
        <span className="eml-toolbar-sep" />
        <button type="button" className={editor.isActive('bulletList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
          •
        </button>
        <button type="button" className={editor.isActive('orderedList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
          1.
        </button>
        <button type="button" className={editor.isActive('blockquote') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
          “
        </button>
        <span className="eml-toolbar-sep" />
        <button type="button" onClick={setLink} title="Link">
          Link
        </button>
        {onImageUpload && (
          <button type="button" onClick={insertImage} title="Insert image">
            Image
          </button>
        )}
        <span className="eml-toolbar-sep" />
        <button type="button" onClick={() => editor.chain().focus().undo().run()} title="Undo">
          Undo
        </button>
        <button type="button" onClick={() => editor.chain().focus().redo().run()} title="Redo">
          Redo
        </button>
      </div>
      <EditorContent editor={editor} className="eml-editor-content" />
    </div>
  );
}
