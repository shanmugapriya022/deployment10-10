/**
 * Optional local-only user seed data is intentionally excluded from source
 * control. Keep a tracked empty fallback so clean GitHub/AI Studio checkouts
 * can build and use Firestore as the source of user records.
 */
const seededUsers: any[] = [];

export default seededUsers;
