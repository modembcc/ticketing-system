export interface Event {
  id: string;
  name: string;
  venue: string;
  startsAt: Date;
  saleStartsAt: Date;
  saleEndsAt: Date;
  capacity: number;
  createdAt: Date;
}

export interface CreateEventInput {
  name: string;
  venue: string;
  startsAt: Date;
  saleStartsAt: Date;
  saleEndsAt: Date;
  capacity: number;
}
