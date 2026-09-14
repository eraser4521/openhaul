/**
 * What a column in someone else's file means here.
 *
 * Every dispatch board and every broker spreadsheet names the same twenty
 * things differently, so a guess is worth making and none of them is worth
 * trusting. Everything below produces a *proposal* the user can overrule on
 * the mapping screen — the aliases exist to save typing, not to decide.
 *
 * Two rules the alias lists follow, both learned from how these files go
 * wrong rather than from how they are supposed to look:
 *
 *  - Nothing is aliased whose meaning inverts. A column named "Operable" is a
 *    perfectly good source for the inoperable flag and mapping it wrong turns
 *    every running car into a winch job. It is left unmapped on purpose; the
 *    user can see it and decide.
 *  - Ambiguous single words go to the field where being wrong is cheapest. A
 *    bare "Price" is the customer's price, not the carrier's pay, because a
 *    wrong tariff is visible on the invoice and a wrong rate quietly
 *    misstates what the driver is owed.
 */

/** Every field an import can fill. Order matters: it resolves contested headers. */
export const IMPORT_FIELDS = [
  'loadNumber',
  'customerName',
  'customerContact',
  'customerEmail',
  'customerPhone',
  'rate',
  'tariff',
  'transportType',
  'distanceMiles',
  'instructions',

  'pickupName',
  'pickupAddress',
  'pickupCity',
  'pickupState',
  'pickupZip',
  'pickupLocation',
  'pickupContact',
  'pickupPhone',
  'pickupDate',

  'deliveryName',
  'deliveryAddress',
  'deliveryCity',
  'deliveryState',
  'deliveryZip',
  'deliveryLocation',
  'deliveryContact',
  'deliveryPhone',
  'deliveryDate',

  'vin',
  'year',
  'make',
  'model',
  'color',
  'vehicleType',
  'lotNumber',
  'inoperable',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export type FieldGroup = 'load' | 'pickup' | 'delivery' | 'vehicle';

export interface FieldSpec {
  field: ImportField;
  group: FieldGroup;
  label: string;
  /** Shown under the label where the field needs explaining. */
  note?: string;
  /** Normalized header names, best first. */
  aliases: string[];
}

export const FIELD_SPECS: Record<ImportField, FieldSpec> = {
  loadNumber: {
    field: 'loadNumber',
    group: 'load',
    label: 'Load number',
    note: 'Rows sharing one number become one load with several vehicles.',
    aliases: [
      'loadnumber',
      'loadid',
      'loadno',
      'load',
      'ordernumber',
      'orderid',
      'orderno',
      'order',
      'referencenumber',
      'refnumber',
      'reference',
      'ref',
      'shipmentnumber',
      'shipmentid',
      'dispatchid',
    ],
  },
  customerName: {
    field: 'customerName',
    group: 'load',
    label: 'Customer',
    note: 'The broker, dealer or person paying. Matched to an existing customer by name.',
    aliases: [
      'customer',
      'customername',
      'broker',
      'brokername',
      'billto',
      'billtoname',
      'client',
      'clientname',
      'account',
      'accountname',
      'company',
      'companyname',
    ],
  },
  customerContact: {
    field: 'customerContact',
    group: 'load',
    label: 'Customer contact',
    aliases: ['customercontact', 'customercontactname', 'brokercontact', 'contact', 'contactname'],
  },
  customerEmail: {
    field: 'customerEmail',
    group: 'load',
    label: 'Customer email',
    aliases: ['customeremail', 'brokeremail', 'email', 'emailaddress', 'billtoemail'],
  },
  customerPhone: {
    field: 'customerPhone',
    group: 'load',
    label: 'Customer phone',
    aliases: ['customerphone', 'brokerphone', 'phone', 'phonenumber', 'telephone'],
  },
  rate: {
    field: 'rate',
    group: 'load',
    label: 'Carrier pay',
    note: 'What the carrier is paid.',
    aliases: [
      'carrierpay',
      'carrierrate',
      'loadrate',
      'rate',
      'rateamount',
      'driverpay',
      'totalpay',
      'pay',
    ],
  },
  tariff: {
    field: 'tariff',
    group: 'load',
    label: 'Customer price',
    note: 'What the customer is billed. The difference from carrier pay is the broker fee.',
    aliases: [
      'customerprice',
      'customerrate',
      'tariff',
      'sellrate',
      'shipperprice',
      'totalprice',
      'invoiceamount',
      'billamount',
      'totalcharge',
      'price',
    ],
  },
  transportType: {
    field: 'transportType',
    group: 'load',
    label: 'Open or enclosed',
    aliases: ['transporttype', 'trailertype', 'equipmenttype', 'equipment', 'transport', 'trailer'],
  },
  distanceMiles: {
    field: 'distanceMiles',
    group: 'load',
    label: 'Miles',
    aliases: ['miles', 'distance', 'distancemiles', 'totalmiles', 'mileage', 'tripmiles'],
  },
  instructions: {
    field: 'instructions',
    group: 'load',
    label: 'Instructions',
    aliases: [
      'instructions',
      'specialinstructions',
      'dispatchnotes',
      'notes',
      'note',
      'comments',
      'comment',
      'remarks',
    ],
  },

  pickupName: {
    field: 'pickupName',
    group: 'pickup',
    label: 'Pickup business',
    aliases: [
      'pickupname',
      'pickupbusiness',
      'pickupcompany',
      'pickupterminal',
      'pickuplocationname',
      'originname',
      'originbusiness',
    ],
  },
  pickupAddress: {
    field: 'pickupAddress',
    group: 'pickup',
    label: 'Pickup street',
    aliases: [
      'pickupaddress',
      'pickupaddress1',
      'pickupaddressline1',
      'pickupstreet',
      'pickupstreetaddress',
      'originaddress',
    ],
  },
  pickupCity: {
    field: 'pickupCity',
    group: 'pickup',
    label: 'Pickup city',
    aliases: ['pickupcity', 'origincity', 'fromcity'],
  },
  pickupState: {
    field: 'pickupState',
    group: 'pickup',
    label: 'Pickup state',
    aliases: ['pickupstate', 'pickupst', 'originstate', 'fromstate'],
  },
  pickupZip: {
    field: 'pickupZip',
    group: 'pickup',
    label: 'Pickup ZIP',
    aliases: ['pickupzip', 'pickupzipcode', 'pickuppostalcode', 'pickuppostcode', 'originzip'],
  },
  pickupLocation: {
    field: 'pickupLocation',
    group: 'pickup',
    label: 'Pickup city and state together',
    note: 'For a single column like "Dallas, TX 75201". Ignored when the separate city column is mapped.',
    aliases: [
      'pickuplocation',
      'pickupcitystate',
      'pickupcitystatezip',
      'origin',
      'origincitystate',
      'origincitystatezip',
      'from',
      'fromcitystate',
    ],
  },
  pickupContact: {
    field: 'pickupContact',
    group: 'pickup',
    label: 'Pickup contact',
    aliases: ['pickupcontact', 'pickupcontactname', 'pickupattn', 'origincontact'],
  },
  pickupPhone: {
    field: 'pickupPhone',
    group: 'pickup',
    label: 'Pickup phone',
    aliases: [
      'pickupphone',
      'pickupcontactphone',
      'pickupphonenumber',
      'pickuptelephone',
      'originphone',
    ],
  },
  pickupDate: {
    field: 'pickupDate',
    group: 'pickup',
    label: 'Pickup date',
    aliases: [
      'pickupdate',
      'pickupdatetime',
      'pickupby',
      'pickupscheduled',
      'readydate',
      'availabledate',
      'firstavailabledate',
      'shipdate',
    ],
  },

  deliveryName: {
    field: 'deliveryName',
    group: 'delivery',
    label: 'Delivery business',
    aliases: [
      'deliveryname',
      'deliverybusiness',
      'deliverycompany',
      'deliveryterminal',
      'deliverylocationname',
      'destinationname',
      'dropoffname',
    ],
  },
  deliveryAddress: {
    field: 'deliveryAddress',
    group: 'delivery',
    label: 'Delivery street',
    aliases: [
      'deliveryaddress',
      'deliveryaddress1',
      'deliveryaddressline1',
      'deliverystreet',
      'deliverystreetaddress',
      'destinationaddress',
      'dropoffaddress',
    ],
  },
  deliveryCity: {
    field: 'deliveryCity',
    group: 'delivery',
    label: 'Delivery city',
    aliases: ['deliverycity', 'destinationcity', 'dropoffcity', 'tocity'],
  },
  deliveryState: {
    field: 'deliveryState',
    group: 'delivery',
    label: 'Delivery state',
    aliases: ['deliverystate', 'deliveryst', 'destinationstate', 'dropoffstate', 'tostate'],
  },
  deliveryZip: {
    field: 'deliveryZip',
    group: 'delivery',
    label: 'Delivery ZIP',
    aliases: [
      'deliveryzip',
      'deliveryzipcode',
      'deliverypostalcode',
      'deliverypostcode',
      'destinationzip',
      'dropoffzip',
    ],
  },
  deliveryLocation: {
    field: 'deliveryLocation',
    group: 'delivery',
    label: 'Delivery city and state together',
    note: 'For a single column like "Phoenix, AZ 85004". Ignored when the separate city column is mapped.',
    aliases: [
      'deliverylocation',
      'deliverycitystate',
      'deliverycitystatezip',
      'destination',
      'dest',
      'destinationcitystate',
      'dropoff',
      'dropofflocation',
      'to',
      'tocitystate',
    ],
  },
  deliveryContact: {
    field: 'deliveryContact',
    group: 'delivery',
    label: 'Delivery contact',
    aliases: ['deliverycontact', 'deliverycontactname', 'deliveryattn', 'destinationcontact'],
  },
  deliveryPhone: {
    field: 'deliveryPhone',
    group: 'delivery',
    label: 'Delivery phone',
    aliases: [
      'deliveryphone',
      'deliverycontactphone',
      'deliveryphonenumber',
      'deliverytelephone',
      'destinationphone',
    ],
  },
  deliveryDate: {
    field: 'deliveryDate',
    group: 'delivery',
    label: 'Delivery date',
    aliases: [
      'deliverydate',
      'deliverydatetime',
      'deliveryby',
      'deliveryscheduled',
      'dropoffdate',
      'estimateddelivery',
      'duedate',
    ],
  },

  vin: {
    field: 'vin',
    group: 'vehicle',
    label: 'VIN',
    note: 'Several VINs in one cell become several vehicles.',
    aliases: ['vin', 'vinnumber', 'vehiclevin', 'vin1', 'fullvin', 'vehicle1vin'],
  },
  year: {
    field: 'year',
    group: 'vehicle',
    label: 'Year',
    aliases: ['year', 'vehicleyear', 'modelyear', 'yr'],
  },
  make: {
    field: 'make',
    group: 'vehicle',
    label: 'Make',
    aliases: ['make', 'vehiclemake', 'manufacturer', 'brand'],
  },
  model: {
    field: 'model',
    group: 'vehicle',
    label: 'Model',
    aliases: ['model', 'vehiclemodel', 'modelname'],
  },
  color: {
    field: 'color',
    group: 'vehicle',
    label: 'Colour',
    aliases: ['color', 'colour', 'vehiclecolor', 'exteriorcolor'],
  },
  vehicleType: {
    field: 'vehicleType',
    group: 'vehicle',
    label: 'Body type',
    aliases: ['vehicletype', 'bodytype', 'bodystyle', 'cartype', 'vehicleclass'],
  },
  lotNumber: {
    field: 'lotNumber',
    group: 'vehicle',
    label: 'Lot or stock number',
    aliases: ['lotnumber', 'lotno', 'lot', 'stocknumber', 'stockno', 'buyernumber'],
  },
  inoperable: {
    field: 'inoperable',
    group: 'vehicle',
    label: 'Inoperable',
    note: 'Yes/no. A column named "Operable" or "Runs" means the opposite — map it only if you invert it first.',
    aliases: ['inoperable', 'inop', 'isinoperable', 'isinop', 'nonrunning', 'nonrunner'],
  },
};

export const GROUP_LABEL: Record<FieldGroup, string> = {
  load: 'Load',
  pickup: 'Pickup',
  delivery: 'Delivery',
  vehicle: 'Vehicle',
};

/** Column index per field; null means nothing in the file fills it. */
export type ColumnMapping = Partial<Record<ImportField, number | null>>;

/**
 * Reduces a header to something comparable.
 *
 * Case, spaces, underscores, punctuation and a trailing unit in brackets all
 * vary between exports of the same report. `Pickup Zip`, `pickup_zip` and
 * `PICKUP ZIP CODE` should not be three different problems.
 */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Proposes a column for each field.
 *
 * Greedy in registry order, and each column is claimed at most once: a file
 * with both `Customer` and `Broker` should fill the customer from one of them
 * and leave the other visibly unused, not silently pick twice. Fields earlier
 * in `IMPORT_FIELDS` win a contested header, which is why the load-level
 * fields are listed before the stop-level ones — a bare `Phone` belongs to
 * the customer, and a pickup phone is always spelled out.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const claimed = new Set<number>();
  const mapping: ColumnMapping = {};

  for (const field of IMPORT_FIELDS) {
    const spec = FIELD_SPECS[field];
    let found: number | null = null;

    for (const alias of spec.aliases) {
      const index = normalized.findIndex((header, at) => header === alias && !claimed.has(at));
      if (index !== -1) {
        found = index;
        break;
      }
    }

    if (found !== null) {
      claimed.add(found);
      mapping[field] = found;
    }
  }

  return mapping;
}

/** Headers no field claimed, by index — shown so nothing looks silently dropped. */
export function unmappedColumns(headers: string[], mapping: ColumnMapping): number[] {
  const used = new Set(
    Object.values(mapping).filter((index): index is number => typeof index === 'number'),
  );
  return headers.map((_, index) => index).filter((index) => !used.has(index));
}
