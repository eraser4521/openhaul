import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { bool, currency, money, orgId, pk, timestamps, ts } from '../columns';
import { organizations, users } from './auth';

/* -------------------------------------------------------------------------
 * Enumerations
 *
 * Values mirror the vocabulary already established by the incumbent tools, so
 * loads imported from a broker's dispatch sheet map cleanly without guesswork.
 * ---------------------------------------------------------------------- */

export const LOAD_STATUSES = [
  'draft',
  'posted',
  'offered',
  'accepted',
  'dispatched',
  'picked_up',
  'in_transit',
  'delivered',
  'invoiced',
  'delivery_verified',
  'paid',
  'cancelled',
  'declined',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

/** Statuses after which the load record becomes legally significant. */
export const IMMUTABLE_AFTER: LoadStatus[] = ['delivered', 'invoiced', 'delivery_verified', 'paid'];

export const TRANSPORT_TYPES = ['open', 'enclosed'] as const;
export type TransportType = (typeof TRANSPORT_TYPES)[number];

export const INSPECTION_TIERS = ['standard', 'advanced', 'aiag'] as const;
export type InspectionTier = (typeof INSPECTION_TIERS)[number];

export const VEHICLE_TYPES = [
  'sedan',
  '2_door_coupe',
  'suv',
  'pickup',
  '4_door_pickup',
  'van',
  'truck_daycab',
  'truck_sleeper',
  'motorcycle',
  'boat',
  'rv',
  'atv',
  'heavy_machinery',
  'livestock',
  'freight',
  'trailer_bumper_pull',
  'trailer_gooseneck',
  'trailer_5th_wheel',
  'other',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const BUSINESS_TYPES = [
  'auction',
  'business',
  'dealer',
  'residential',
  'port',
  'terminal',
  'repo_yard',
] as const;

export const PAYMENT_METHODS = [
  'cash',
  'check',
  'cashiers_check',
  'money_order',
  'comchek',
  'ach',
  'direct_deposit',
  'credit_card',
  'zelle',
  'venmo',
  'cashapp',
  'other',
] as const;

export const PAYMENT_TERMS = [
  'on_pickup',
  'on_delivery',
  'cash_on_pickup',
  'cash_on_delivery',
  'check_on_pickup',
  'check_on_delivery',
  'quickpay',
  'ach',
  '2_days',
  '5_days',
  '7_days',
  '10_days',
  '15_days',
  '20_days',
  '30_days',
  '45_days',
  '60_days',
  'other',
] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const STOP_KINDS = ['pickup', 'delivery'] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/* -------------------------------------------------------------------------
 * Counterparties and places
 * ---------------------------------------------------------------------- */

/** A broker, shipper, dealer or private customer this carrier works with. */
export const customers = sqliteTable(
  'customers',
  {
    id: pk(),
    orgId: orgId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['broker', 'shipper', 'dealer', 'private', 'auction'] })
      .notNull()
      .default('broker'),

    usdotNumber: text('usdot_number'),
    mcNumber: text('mc_number'),

    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),

    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),

    defaultPaymentTerms: text('default_payment_terms', { enum: PAYMENT_TERMS }),
    /** Free-text notes; never store payment credentials here. */
    notes: text('notes'),
    archivedAt: ts('archived_at'),
    ...timestamps,
  },
  (t) => [
    // Parent key for composite foreign keys from child tables.
    uniqueIndex('customers_org_id_uq').on(t.orgId, t.id),
    index('customers_org_name_idx').on(t.orgId, t.name),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'customers_org_fk',
    }).onDelete('cascade'),
  ],
);

/** A physical location a vehicle is collected from or delivered to. */
export const venues = sqliteTable(
  'venues',
  {
    id: pk(),
    orgId: orgId(),
    name: text('name').notNull(),
    businessType: text('business_type', { enum: BUSINESS_TYPES }).notNull().default('business'),

    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    postalCode: text('postal_code').notNull(),
    country: text('country').notNull().default('US'),

    latitude: integer('latitude'),
    longitude: integer('longitude'),

    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),

    gateCode: text('gate_code'),
    /** Transportation Worker Identification Credential required to enter. */
    requiresTwic: bool('requires_twic').notNull().default(false),
    hoursNote: text('hours_note'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('venues_org_id_uq').on(t.orgId, t.id),
    index('venues_org_city_idx').on(t.orgId, t.state, t.city),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'venues_org_fk',
    }).onDelete('cascade'),
  ],
);

/* -------------------------------------------------------------------------
 * Fleet
 * ---------------------------------------------------------------------- */

export const drivers = sqliteTable(
  'drivers',
  {
    id: pk(),
    orgId: orgId(),
    /** Null for a driver who has not been given an account yet. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    displayName: text('display_name').notNull(),
    /** Points at `piiVault`; licence number and DOB live there encrypted. */
    subjectId: text('subject_id'),

    cdlState: text('cdl_state'),
    cdlClass: text('cdl_class', { enum: ['A', 'B', 'C'] }),
    cdlExpiresOn: ts('cdl_expires_on'),
    medicalCardExpiresOn: ts('medical_card_expires_on'),

    /** Share of load revenue, in basis points. 2800 = 28%. */
    payRateBps: integer('pay_rate_bps'),

    activeAt: ts('active_at'),
    deactivatedAt: ts('deactivated_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('drivers_org_id_uq').on(t.orgId, t.id),
    index('drivers_org_idx').on(t.orgId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'drivers_org_fk',
    }).onDelete('cascade'),
  ],
);

/** Tractors and trailers. Capacity is tracked in both slots and pounds. */
export const equipment = sqliteTable(
  'equipment',
  {
    id: pk(),
    orgId: orgId(),
    kind: text('kind', { enum: ['tractor', 'trailer'] }).notNull(),
    label: text('label').notNull(),
    vin: text('vin'),
    plate: text('plate'),
    plateState: text('plate_state'),

    transportType: text('transport_type', { enum: TRANSPORT_TYPES }),
    /**
     * Slot capacity — typically 7 to 10 for an open car hauler. Capacity is
     * really weight-driven, so `capacityLbs` is the binding constraint when
     * hauling pickups rather than sedans.
     */
    capacitySlots: integer('capacity_slots'),
    capacityLbs: integer('capacity_lbs'),

    annualInspectionDueOn: ts('annual_inspection_due_on'),
    activeAt: ts('active_at'),
    retiredAt: ts('retired_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('equipment_org_id_uq').on(t.orgId, t.id),
    index('equipment_org_kind_idx').on(t.orgId, t.kind),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'equipment_org_fk',
    }).onDelete('cascade'),
  ],
);

/* -------------------------------------------------------------------------
 * Trips and loads
 * ---------------------------------------------------------------------- */

/** A driver's run: several loads sequenced across one route. */
export const trips = sqliteTable(
  'trips',
  {
    id: pk(),
    orgId: orgId(),
    name: text('name').notNull(),
    driverId: text('driver_id'),
    tractorId: text('tractor_id'),
    trailerId: text('trailer_id'),

    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('trips_org_id_uq').on(t.orgId, t.id),
    index('trips_org_driver_idx').on(t.orgId, t.driverId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'trips_org_fk',
    }).onDelete('cascade'),
    // Composite: a trip can only reference a driver in its own organisation.
    foreignKey({
      columns: [t.orgId, t.driverId],
      foreignColumns: [drivers.orgId, drivers.id],
      name: 'trips_driver_fk',
    }),
  ],
);

/**
 * A load: one or more vehicles moving from one pickup to one delivery under
 * a single agreement.
 */
export const loads = sqliteTable(
  'loads',
  {
    id: pk(),
    orgId: orgId(),
    /** Human-facing reference, unique within the organisation. */
    number: text('number').notNull(),

    status: text('status', { enum: LOAD_STATUSES }).notNull().default('draft'),
    transportType: text('transport_type', { enum: TRANSPORT_TYPES }).notNull().default('open'),
    inspectionTier: text('inspection_tier', { enum: INSPECTION_TIERS })
      .notNull()
      .default('advanced'),

    customerId: text('customer_id'),
    tripId: text('trip_id'),
    driverId: text('driver_id'),

    /** Carrier pay, in cents. */
    rateCents: money('rate_cents'),
    /** What the customer is billed, in cents. The spread is the broker fee. */
    tariffCents: money('tariff_cents'),
    brokerFeeCents: money('broker_fee_cents'),
    /** Always its own line; never folded into the line-haul rate. */
    fuelSurchargeCents: money('fuel_surcharge_cents'),
    depositCents: money('deposit_cents'),
    /** Collected by the driver at pickup or delivery. */
    codAmountCents: money('cod_amount_cents'),
    codMethod: text('cod_method', { enum: ['cash', 'check'] }),
    codLocation: text('cod_location', { enum: STOP_KINDS }),
    currency: currency(),

    paymentTerms: text('payment_terms', { enum: PAYMENT_TERMS }),
    paymentMethod: text('payment_method', { enum: PAYMENT_METHODS }),

    distanceMiles: integer('distance_miles'),
    deadheadMiles: integer('deadhead_miles'),

    purchaseOrderNumber: text('purchase_order_number'),
    rateConfirmationNumber: text('rate_confirmation_number'),

    instructions: text('instructions'),
    internalNotes: text('internal_notes'),

    dispatchedAt: ts('dispatched_at'),
    pickedUpAt: ts('picked_up_at'),
    deliveredAt: ts('delivered_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),

    /** Suspends every retention and purge job for this load and its children. */
    legalHold: bool('legal_hold').notNull().default(false),
    retainUntil: ts('retain_until'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('loads_org_id_uq').on(t.orgId, t.id),
    // Per-tenant, never global: a global unique index on `number` would leak
    // the existence of another carrier's load through a duplicate-key error.
    uniqueIndex('loads_org_number_uq').on(t.orgId, t.number),
    index('loads_org_status_idx').on(t.orgId, t.status),
    index('loads_org_driver_idx').on(t.orgId, t.driverId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'loads_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'loads_customer_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.tripId],
      foreignColumns: [trips.orgId, trips.id],
      name: 'loads_trip_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.driverId],
      foreignColumns: [drivers.orgId, drivers.id],
      name: 'loads_driver_fk',
    }),
  ],
);

/** The pickup and delivery ends of a load. */
export const stops = sqliteTable(
  'stops',
  {
    id: pk(),
    orgId: orgId(),
    loadId: text('load_id').notNull(),
    kind: text('kind', { enum: STOP_KINDS }).notNull(),
    sequence: integer('sequence').notNull().default(0),

    venueId: text('venue_id'),

    /** 'estimated' windows are advisory; 'exact' are committed appointments. */
    dateType: text('date_type', { enum: ['estimated', 'exact'] }).notNull().default('estimated'),
    scheduledAt: ts('scheduled_at'),
    scheduledEndsAt: ts('scheduled_ends_at'),
    firstAvailableAt: ts('first_available_at'),

    arrivedAt: ts('arrived_at'),
    completedAt: ts('completed_at'),

    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('stops_org_id_uq').on(t.orgId, t.id),
    index('stops_load_idx').on(t.loadId),
    foreignKey({
      columns: [t.orgId, t.loadId],
      foreignColumns: [loads.orgId, loads.id],
      name: 'stops_load_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.venueId],
      foreignColumns: [venues.orgId, venues.id],
      name: 'stops_venue_fk',
    }),
  ],
);

/** A single vehicle on a load. */
export const vehicles = sqliteTable(
  'vehicles',
  {
    id: pk(),
    orgId: orgId(),
    loadId: text('load_id').notNull(),

    vin: text('vin').notNull(),
    /** False for a pre-1981 or otherwise non-standard VIN. */
    vinCheckDigitValid: integer('vin_check_digit_valid', { mode: 'boolean' }),

    year: integer('year'),
    make: text('make'),
    model: text('model'),
    trim: text('trim'),
    color: text('color'),
    vehicleType: text('vehicle_type', { enum: VEHICLE_TYPES }).notNull().default('sedan'),
    bodyClass: text('body_class'),

    plate: text('plate'),
    plateState: text('plate_state'),
    lotNumber: text('lot_number'),

    odometer: integer('odometer'),
    curbWeightLbs: integer('curb_weight_lbs'),
    declaredValueCents: money('declared_value_cents'),
    /** Per-vehicle share of the load rate, in cents. */
    priceCents: money('price_cents'),

    /**
     * Inoperable vehicles change loading position, equipment and price, and
     * an undisclosed one is the most common cause of a refused load.
     */
    isInoperable: bool('is_inoperable').notNull().default(false),
    inoperableReason: text('inoperable_reason'),
    isOversized: bool('is_oversized').notNull().default(false),
    requiresEnclosed: bool('requires_enclosed').notNull().default(false),

    /** Raw NHTSA vPIC response, cached so a decode is never repeated. */
    nhtsaDecodedAt: ts('nhtsa_decoded_at'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('vehicles_org_id_uq').on(t.orgId, t.id),
    index('vehicles_load_idx').on(t.loadId),
    index('vehicles_org_vin_idx').on(t.orgId, t.vin),
    foreignKey({
      columns: [t.orgId, t.loadId],
      foreignColumns: [loads.orgId, loads.id],
      name: 'vehicles_load_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Cache of NHTSA vPIC decodes.
 *
 * A VIN's manufacturing specification never changes, so these rows never
 * expire. Shared across organisations because the data is public and
 * contains nothing tenant-specific.
 */
export const vinDecodes = sqliteTable('vin_decodes', {
  vin: text('vin').primaryKey(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  errorCode: text('error_code'),
  fetchedAt: ts('fetched_at')
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Load = typeof loads.$inferSelect;
export type Vehicle = typeof vehicles.$inferSelect;
export type Stop = typeof stops.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Venue = typeof venues.$inferSelect;
export type Driver = typeof drivers.$inferSelect;
export type Equipment = typeof equipment.$inferSelect;
export type Trip = typeof trips.$inferSelect;
