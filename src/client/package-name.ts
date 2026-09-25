/**
 * This bundle's npm package name.
 *
 * Kept in its own module so both halves and the build config can name the
 * bundle without importing the client entry (which pulls in the stylesheet and
 * React component tree).
 */

/** The package name the client loader keys this bundle's registration under. */
export const PACKAGE_NAME = 'dsh-project-groups'
