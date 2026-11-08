import { z } from 'zod';

/**
 * Wire schemas for the backend HTTP APIs. Every backend response is validated against these;
 * anything that does not conform is reported as MALFORMED_RESPONSE rather than passed through.
 */

/** Shipment identifiers look like `SHP-` followed by 6–12 digits. */
export const SHIPMENT_ID_PATTERN = /^SHP-\d{6,12}$/;
export const ShipmentIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SHIPMENT_ID_PATTERN, 'Shipment ID must look like SHP-123456 (SHP- followed by 6-12 digits)');

const IsoDateTime = z.iso.datetime({ offset: true });
const IsoDate = z.iso.date();

export const ShipmentStatusValues = [
  'LABEL_CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
  'RETURNED',
] as const;

export const BackendShipmentSchema = z.object({
  shipmentId: z.string(),
  status: z.enum(ShipmentStatusValues),
  carrier: z.string(),
  origin: z.string(),
  destination: z.string(),
  estimatedDelivery: IsoDate.nullable(),
  lastUpdated: IsoDateTime,
});
export type BackendShipment = z.infer<typeof BackendShipmentSchema>;

export const BackendTrackingEventSchema = z.object({
  timestamp: IsoDateTime,
  location: z.string(),
  code: z.string(),
  description: z.string(),
});

export const BackendTrackingSchema = z.object({
  shipmentId: z.string(),
  events: z.array(BackendTrackingEventSchema),
});
export type BackendTracking = z.infer<typeof BackendTrackingSchema>;

export const BackendExceptionSchema = z.object({
  exceptionId: z.string(),
  type: z.enum(['ADDRESS_ISSUE', 'DAMAGED', 'DELAYED', 'CUSTOMS_HOLD', 'RECIPIENT_UNAVAILABLE', 'LOST', 'OTHER']),
  description: z.string(),
  occurredAt: IsoDateTime,
  resolutionStatus: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']),
});

export const BackendExceptionsSchema = z.object({
  shipmentId: z.string(),
  exceptions: z.array(BackendExceptionSchema),
});
export type BackendExceptions = z.infer<typeof BackendExceptionsSchema>;

export const TicketCategoryValues = ['DELAY', 'DAMAGE', 'LOST', 'ADDRESS_CHANGE', 'DELIVERY_EXCEPTION', 'OTHER'] as const;

export const BackendTicketSchema = z.object({
  ticketId: z.string(),
  shipmentId: z.string(),
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']),
  category: z.enum(TicketCategoryValues),
  createdAt: IsoDateTime,
});
export type BackendTicket = z.infer<typeof BackendTicketSchema>;
