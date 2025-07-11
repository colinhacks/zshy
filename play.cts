import foo = require('my-pkg/hello')

foo();
// commonjs, unnecessarily ugly and confusing
// even if you like it for some reason, it's not "the same"
// const { default: foo } = require('foo')
