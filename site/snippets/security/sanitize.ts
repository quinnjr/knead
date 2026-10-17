import { Module } from '@knead-js/core';
import { Controller, type Ctx, Post } from '@knead-js/http';
import { POLICIES, type SanitizePolicy, sanitize, sanitizedHtml } from '@knead-js/sanitize';
import * as v from 'valibot';

// #region function
export const preview = sanitize('<p onclick="steal()">Hi <b>there</b></p><script>steal()</script>');
// '<p>Hi <b>there</b></p>'

export const plain = sanitize('<p>Hi <b>there</b></p>', 'strict');
// 'Hi there'
// #endregion function

// #region policy
export const commentPolicy: SanitizePolicy = {
  allowedTags: [...POLICIES.basic.allowedTags, 'blockquote'],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['https'],
};

export const comment = sanitize(
  '<a href="http://example.com" title="Docs">docs</a> <a href="https://example.com">docs</a>',
  commentPolicy,
);
// '<a title="Docs" rel="noopener noreferrer">docs</a> <a href="https://example.com" rel="noopener noreferrer">docs</a>'
// #endregion policy

// #region schema
@Controller('/notes')
export class NotesController {
  // The whole body is the HTML: send it as text/plain.
  @Post('/', { body: sanitizedHtml(v.pipe(v.string(), v.maxLength(10_000)), 'rich') })
  create(ctx: Ctx<{ body: string }>) {
    return { html: ctx.body };
  }
}
// #endregion schema

// #region field
const CreatePost = v.object({
  title: v.pipe(v.string(), v.maxLength(200)),
  body: v.pipe(
    v.string(),
    v.maxLength(50_000),
    v.transform((html) => sanitize(html, 'basic')),
  ),
});

@Controller('/posts')
export class PostsController {
  @Post('/', { body: CreatePost })
  create(ctx: Ctx<{ body: v.InferOutput<typeof CreatePost> }>) {
    return ctx.body;
  }
}
// #endregion field

@Module({ controllers: [NotesController, PostsController] })
export class AppModule {}
