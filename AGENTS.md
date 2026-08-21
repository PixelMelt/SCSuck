## Constraints

This repo changes fast, do not write comments.

When importing and exporting functions/types, see if any files are importing functions/types that should be exposed through barrel export entrypoint instead of pulled directly from the submodule.

When planning to write in a new feature, do a full analysis of the module and trace the data flow through it to determine if there is irrelevant defensive programming, simplifiable code or just outright dead code in it

Think about "is this level of abstraction worth keeping?" "We have an abstraction here, but arent actually using any of the benefits it gives us." "What jobs does this file have? Would it be better to split it into multiple?"

Say things like "I'm going to trace the data it creates across module boundaries." "This logic is better suited for a different folder."

Any type that crosses module boundaries gets promoted to /types. Module-internal types stay/are downgraded to local. The key discipline is: if more than one module needs a type, it moves to types/.

If you are adding any kind of undefined or null checks you will analyze the flow of data through the code to make sure they are actually needed at that location. This makes sure we dont add dead guards.

Write no fallbacks, prefer fail loudly.

When replacing/migrating a code path, carry the change through to the obvious finish line.

Local cleanup is good, but boundary cleanup and state ownership cleanup is better.

Architectural rulings live in `DECISIONS.md`. Read it before proposing structural changes; do not re-litigate what it settles.
