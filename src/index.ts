/**
 * Host half of dsh-project-groups.
 *
 * L0 carries no host-side behaviour: the plugin is a pure client view
 * replacement, so there is nothing to register, watch, or persist here yet.
 * Later layers (project records, session assignment, document injection) will
 * mount into this same apply.
 */
export function apply(): void {}
