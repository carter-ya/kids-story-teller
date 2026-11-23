# Repository Guidelines

This workspace is the starting point for `kids-story-teller`. The project has yet to establish a source tree, build system, or test suite. Use the first implementation change to document a workflow that another contributor can repeat.

## Project Structure

When introducing code, follow the chosen framework’s directory conventions. Record the source entry point, test location, and location of any story text, illustrations, or audio in this guide. If an asset is generated, identify its editable source so contributors know which file to change.

## Local Development and Testing

When adding the first runnable feature, document the runtime version and the exact commands to install dependencies, start the application, and run its tests. Verify the commands from the project root. If a build step produces a distributable artifact, include the command and output path.

Add a test alongside the first testable behavior. Use a test name that describes the expected result, and document how to run that test individually. A coverage target can be recorded here once the project adopts one.

## Coding Style

Use the chosen language’s standard formatter and naming conventions. When introducing a formatter or linter, commit its configuration where needed and document the check command so contributors can reproduce its results locally.

## Commits and Pull Requests

Git history is unavailable in this workspace. As an initial convention, use a short imperative commit subject, such as `Add story selection`. In a pull request, explain the change and how you verified it. Link a related issue when one exists and include a screenshot for a visible interface change.
