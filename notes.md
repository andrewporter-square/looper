
Take a look at the ./i18n-static-keys-research-MEGA.md file for comprehensive details on what we're trying to accomplish.

Then start looking at the file specified above and the tests, and figure out what we need to change to do the job. Please ask any questions you may have. Please try to make the changes and get the tests passing.

We want the code to be as simple and linear if possible. Try to minimize branching logic. If we need branching logic, try to contain it to simple functions and keep the core flow as simple as possible.

No nested ternaries!

The easier the code is to reason about and test, the better.

When possible, please add assertions on the new i18n keys to tests or add new tests. We want to be thorough and make this change as safely as possible without breaking anything. If we can/should update e2e tests, please do so.

At the very least, we want to have some test coverage to ensure that the keys we expect to be rendered via i18n are in fact rendered.

Use this generalized style guide:

Prefer declarative mappings over condition-heavy logic.
Include the t() and Trans component calls into the declarative mapping so the i18n keys remain static
Encode permutations in typed objects/maps.
Use small selectors to choose the right entry.
Keep control flow simple and linear.
Use named if/switch selectors.
Avoid nested ternaries and deep inline branching.
Separate decision logic from rendering/execution.
Compute a single "selected config/view model" first.
Keep render/use sites trivial and direct.
Use explicit types at boundaries.
Define interfaces/types for map shapes and returned objects.
Make invalid states hard to represent.
Centralize variation points.
Put variant/mode/state differences in one place.
Avoid scattering the same branching across multiple callsites.
Favor clarity over cleverness.
Repetition is acceptable when it improves readability.
Optimize only after structure is clear.
Keep behavior testable by branch.
Write assertions against selected outputs for each variant/path.
Test special-case overrides explicitly.