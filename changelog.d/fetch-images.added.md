- **`modules.fetch.images`: the model that answers a fetch `prompt` can look at
  a page's images.** Off by default. On, a page keeps the address of each image
  worth looking at, one with no alt text too, and the answering model gets a
  `view_image` tool for them: up to four a call, PNG, JPEG, GIF or WebP, only
  addresses the page itself names, under the same address guard as the page.
  The result says which images it looked at. A request the text answers
  fetches none.
