/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector, useActions } from '../../services/state/store.js';
import {
  Typography,
  Button,
  Space,
  Card,
  Row,
  Col,
  Image,
  Divider,
  Descriptions,
  Banner,
  Spin,
  Toast,
  TextArea,
  Tooltip,
} from '@douyinfe/semi-ui-19';
import {
  IconArrowLeft,
  IconMapPin,
  IconCart,
  IconClock,
  IconBriefcase,
  IconActivity,
  IconLink,
  IconDelete,
  IconExpand,
  IconGridView,
} from '@douyinfe/semi-icons';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import no_image from '../../assets/no_image.png';
import * as timeService from '../../services/time/timeService.js';
import { formatEuroPrice } from '../../services/price/priceService.js';
import { xhrDelete } from '../../services/xhr.js';
import ListingDeletionModal from '../../components/ListingDeletionModal.jsx';

import Headline from '../../components/headline/Headline.jsx';
import StatusControl from '../../components/listings/StatusControl.jsx';
import './ListingDetail.less';
import { useTranslation, useLocale } from '../../services/i18n/i18n.jsx';

const { Title, Text } = Typography;

const STYLES = {
  STANDARD: 'https://tiles.openfreemap.org/styles/bright',
};

export default function ListingDetail() {
  const t = useTranslation();
  const locale = useLocale();
  const { listingId } = useParams();
  const navigate = useNavigate();
  const actions = useActions();
  const listing = useSelector((state) => state.listingsData.currentListing);
  const userSettings = useSelector((state) => state.userSettings.settings);
  const listingDeletionPref = userSettings?.listing_deletion_preference;
  const defaultDeleteType = listingDeletionPref?.hardDelete ? 'hard' : 'soft';
  const mapContainer = useRef(null);
  const map = useRef(null);
  const [loading, setLoading] = useState(true);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);

  useEffect(() => {
    async function fetchListing() {
      try {
        setLoading(true);
        await actions.listingsData.getListing(listingId);
      } catch (e) {
        console.error('Failed to load listing details:', e);
        Toast.error(t('listing.detail.toastLoadError'));
        navigate('/listings');
      } finally {
        setLoading(false);
      }
    }
    fetchListing();
  }, [listingId]);

  useEffect(() => {
    setNotesDraft(listing?.notes ?? '');
  }, [listing?.id, listing?.notes]);

  const hasGeo =
    listing?.latitude != null && listing?.longitude != null && listing?.latitude !== -1 && listing?.longitude !== -1;

  useEffect(() => {
    if (loading || !listing || !mapContainer.current || !hasGeo) return;

    if (map.current) {
      map.current.remove();
    }

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: STYLES.STANDARD,
      center: [listing.longitude, listing.latitude],
      zoom: 14,
      cooperativeGestures: true,
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

    new maplibregl.Marker({ color: '#3FB1CE' })
      .setLngLat([listing.longitude, listing.latitude])
      .setPopup(
        new maplibregl.Popup({ offset: 25 }).setHTML(
          `<h4>${t('listing.detail.mapPopupListingLocation')}</h4><p>${listing.address}</p>`,
        ),
      )
      .addTo(map.current);

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, [listing, loading]);

  const confirmDeletion = async (hardDelete, remember) => {
    try {
      if (remember) {
        await actions.userSettings.setListingDeletionPreference({ skipPrompt: true, hardDelete });
      }
      await xhrDelete('/api/listings/', { ids: [listing.id], hardDelete });
      Toast.success(t('listing.detail.toastDeleted'));
      navigate('/listings');
    } catch (e) {
      Toast.error(e.message || t('listing.detail.toastDeleteError'));
    } finally {
      setDeleteModalVisible(false);
    }
  };

  const handleStatusChange = async (next) => {
    try {
      await actions.listingsData.setListingStatus(listing.id, next);
      await actions.listingsData.getListing(listingId);
      Toast.success(next ? t('listings.toastStatusMarked', { status: next }) : t('listings.toastStatusCleared'));
    } catch (e) {
      console.error('Failed to update status:', e);
      Toast.error(t('listings.toastStatusUpdateError'));
    }
  };

  const handleSaveNotes = async () => {
    if (!listing) return;
    setNotesSaving(true);
    try {
      await actions.listingsData.setListingNotes(listing.id, notesDraft);
      await actions.listingsData.getListing(listingId);
      Toast.success(t('listing.detail.toastNotesSaved'));
    } catch (e) {
      console.error('Failed to save notes:', e);
      Toast.error(t('listing.detail.toastNotesError'));
    } finally {
      setNotesSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!listing) return null;

  const statusKeyMap = {
    applied: 'listing.detail.statusApplied',
    accepted: 'listing.detail.statusAccepted',
    rejected: 'listing.detail.statusRejected',
  };
  const statusLabel = listing.status?.status ? t(statusKeyMap[listing.status.status] ?? listing.status.status) : null;

  const data = [
    {
      key: t('listing.detail.fieldPrice'),
      value: listing.price ? (
        <span className="listing-detail__price">{formatEuroPrice(listing.price)}</span>
      ) : (
        t('common.na')
      ),
      Icon: <IconCart />,
      helpText: t('listing.detail.fieldPriceHelp'),
    },
    {
      key: t('listing.detail.fieldSize'),
      value: listing.size ? `${listing.size} m²` : t('common.na'),
      Icon: <IconExpand />,
      helpText: t('listing.detail.fieldSizeHelp'),
    },
    {
      key: t('listing.detail.fieldRooms'),
      value: listing.rooms ? t('listing.detail.fieldRoomsValue', { count: listing.rooms }) : t('common.na'),
      Icon: <IconGridView />,
      helpText: t('listing.detail.fieldRoomsHelp'),
    },
    {
      key: t('listing.detail.fieldJob'),
      value: listing.job_name,
      Icon: <IconBriefcase />,
      helpText: t('listing.detail.fieldJobHelp'),
    },
    {
      key: t('listing.detail.fieldProvider'),
      value: listing.provider ? listing.provider.charAt(0).toUpperCase() + listing.provider.slice(1) : 'Unknown',
      Icon: <IconBriefcase />,
      helpText: t('listing.detail.fieldProviderHelp'),
    },
    {
      key: t('listing.detail.fieldAdded'),
      value: timeService.format(listing.created_at, true, locale),
      Icon: <IconClock />,
      helpText: t('listing.detail.fieldAddedHelp'),
    },
  ];

  if (statusLabel) {
    data.push({
      key: t('listing.detail.fieldStatus'),
      value: listing.status?.setAt
        ? `${statusLabel} ${t('listing.detail.statusSetAt', { date: timeService.format(listing.status.setAt, true, locale) })}`
        : statusLabel,
      Icon: <IconActivity />,
      helpText: t('listing.detail.fieldStatusHelp'),
    });
  }

  return (
    <div className="listing-detail">
      <Headline
        text={listing?.title || t('listing.detail.defaultTitle')}
        actions={
          <Button icon={<IconArrowLeft />} onClick={() => navigate(-1)} theme="borderless" style={{ color: '#909090' }}>
            {t('listing.detail.back')}
          </Button>
        }
      />

      <Card className="listing-detail__card">
        <div className="listing-detail__header">
          <Space align="center">
            <IconMapPin style={{ fontSize: '18px', color: 'var(--semi-color-primary)' }} />
            {listing.address ? (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(listing.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="listing-detail__address-link"
              >
                {listing.address}
              </a>
            ) : (
              <Text type="secondary">{t('listing.detail.noAddress')}</Text>
            )}
          </Space>
          <Space wrap className="listing-detail__header-actions">
            <StatusControl status={listing.status?.status ?? null} onChange={handleStatusChange} />
            <a href={listing.link} target="_blank" rel="noopener noreferrer" className="listing-detail__open-btn">
              <IconLink style={{ marginRight: 6 }} />
              {t('listing.detail.openListing')}
            </a>
            <Button
              icon={<IconDelete />}
              onClick={() => {
                if (listingDeletionPref?.skipPrompt) {
                  confirmDeletion(listingDeletionPref.hardDelete);
                  return;
                }
                setDeleteModalVisible(true);
              }}
              theme="light"
              type="danger"
            >
              {t('listing.detail.delete')}
            </Button>
          </Space>
        </div>

        <Row>
          <Col span={24} lg={12}>
            <div
              className={`listing-detail__image-container${!listing.image_url ? ' listing-detail__image-container--placeholder' : ''}`}
            >
              <Image
                src={listing.image_url ?? no_image}
                fallback={<img src={no_image} alt={t('listing.detail.noImageAlt')} />}
                style={{ width: '100%', height: '100%' }}
                preview={!!listing.image_url}
              />
            </div>

            <div className="listing-detail__notes">
              <Title heading={4} className="listing-detail__notes-title">
                {t('listing.detail.notesTitle')}
              </Title>
              <TextArea
                value={notesDraft}
                onChange={(val) => setNotesDraft(val)}
                placeholder={t('listing.detail.notesPlaceholder')}
                rows={5}
                autosize={{ minRows: 4, maxRows: 12 }}
                className="listing-detail__notes-textarea"
                showClear
              />
              <Space className="listing-detail__notes-actions">
                <Button
                  theme="solid"
                  type="primary"
                  loading={notesSaving}
                  disabled={notesSaving || (notesDraft ?? '') === (listing.notes ?? '')}
                  onClick={handleSaveNotes}
                >
                  {t('listing.detail.storeNotes')}
                </Button>
              </Space>
            </div>
          </Col>
          <Col span={24} lg={12}>
            <div className="listing-detail__info-section">
              <Title heading={4} style={{ marginBottom: '1rem' }}>
                {t('listing.detail.detailsTitle')}
              </Title>
              <Descriptions column={1}>
                {data.map((item, index) => (
                  <Descriptions.Item key={index}>
                    <Tooltip content={item.helpText} position="left">
                      <span className="listing-detail__details-item">
                        {item.Icon}
                        {item.value}
                      </span>
                    </Tooltip>
                  </Descriptions.Item>
                ))}
              </Descriptions>
              <Divider margin="1.5rem" />
              <Title heading={4} style={{ marginBottom: '1rem' }}>
                {t('listing.detail.descriptionTitle')}
              </Title>
              <Text type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                {listing.description || t('listing.detail.noDescription')}
              </Text>
            </div>
          </Col>
        </Row>
      </Card>

      <div className="listing-detail__map-wrapper">
        <Title heading={3}>{t('listing.detail.locationTitle')}</Title>
        {!hasGeo ? (
          <Banner
            type="warning"
            bordered
            description={t('listing.detail.noGeoWarning')}
            style={{ marginTop: '1rem' }}
          />
        ) : (
          <div ref={mapContainer} className="listing-detail__map-container" />
        )}
      </div>

      <ListingDeletionModal
        visible={deleteModalVisible}
        defaultDeleteType={defaultDeleteType}
        onConfirm={confirmDeletion}
        onCancel={() => setDeleteModalVisible(false)}
      />
    </div>
  );
}
