- **Recipe authors:** a recipe key `ownSettings` now has a meaning. Before
  this change, the host warned that it ignores the key, and the recipe
  loaded with any value there. Now the recipe loads only where the value is
  `"all"`, `"read"` or a non-empty list of setting names. To migrate,
  remove the key, or give it one of those values.
