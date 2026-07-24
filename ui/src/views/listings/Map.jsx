/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useRef, useState } from 'react';
import { parseBoolean, parseNumber, parseString, useSearchParamState } from '../../hooks/useSearchParamState.js';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useActions, useSelector } from '../../services/state/store.js';
import { generateCircleCoords, getBoundsFromCenter, getBoundsFromCoords } from './mapUtils.js';
import { Banner, Select, Switch, Toast, Typography } from '@douyinfe/semi-ui-19';

import no_image from '../../assets/no_image.png';
import _RangeSlider from 'react-range-slider-input';
import 'react-range-slider-input/dist/style.css';
import './Map.less';
import { xhrDelete } from '../../services/xhr.js';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ListingDeletionModal from '../../components/ListingDeletionModal.jsx';
import Map from '../../components/map/Map.jsx';
import Headline from '../../components/headline/Headline.jsx';
import { useTranslation } from '../../services/i18n/i18n.jsx';

const RangeSlider = _RangeSlider?.default ?? _RangeSlider;

const { Text } = Typography;

export default function MapView() {
  const t = useTranslation();
  const mapContainer = useRef(null);
  const map = useRef(null);
  const homeMarker = useRef(null);
  const actions = useActions();
  const navigate = useNavigate();
  const sp = useSearchParams();
  const [searchParams, setSearchParams] = sp;
  const listings = useSelector((state) => state.listingsData.mapListings);
  const userSettings = useSelector((state) => state.userSettings.settings);
  const homeAddress = userSettings?.home_address;
  const listingDeletionPref = userSettings?.listing_deletion_preference;
  const defaultDeleteType = listingDeletionPref?.hardDelete ? 'hard' : 'soft';

  const jobs = useSelector((state) => state.jobsData.jobs);
  const [jobId, setJobId] = useSearchParamState(sp, 'job', null, parseString);
  const [distanceFilter, setDistanceFilter] = useSearchParamState(sp, 'distance', 0, parseNumber);
  const [style] = useSearchParamState(sp, 'style', 'STANDARD', parseString);
  const [marketModel, setMarketModel] = useSearchParamState(sp, 'model', 'gbm', parseString);
  const [show3dBuildings, setShow3dBuildings] = useSearchParamState(sp, 'buildings', false, parseBoolean);

  // Price range: stored as priceMin/priceMax URL params; default max derived from loaded listings
  const urlPriceMin = searchParams.has('priceMin') ? Number(searchParams.get('priceMin')) : null;
  const urlPriceMax = searchParams.has('priceMax') ? Number(searchParams.get('priceMax')) : null;
  const [priceRange, setPriceRange] = useState([urlPriceMin ?? 0, urlPriceMax ?? 0]);

  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [listingToDelete, setListingToDelete] = useState(null);
  const deleteListingRef = useRef(null);

  const confirmListingDeletion = async (hardDelete, remember, id = listingToDelete) => {
    try {
      if (remember) {
        await actions.userSettings.setListingDeletionPreference({ skipPrompt: true, hardDelete });
      }
      await xhrDelete('/api/listings/', { ids: [id], hardDelete });
      Toast.success(t('map.toastDeleted'));
      fetchListings();
    } catch (error) {
      Toast.error(error.message || t('map.toastDeleteError'));
    } finally {
      setDeleteModalVisible(false);
      setListingToDelete(null);
    }
  };

  deleteListingRef.current = (id) => {
    if (listingDeletionPref?.skipPrompt) {
      confirmListingDeletion(listingDeletionPref.hardDelete, false, id);
      return;
    }
    setListingToDelete(id);
    setDeleteModalVisible(true);
  };

  useEffect(() => {
    // Only reset to full range when no URL override is set
    if (urlPriceMax === null) {
      setPriceRange([0, getMaxPrice()]);
    }
  }, [listings]);

  const getMaxPrice = () => {
    return listings.reduce((acc, item) => {
      const price = Number(item.price);
      return Number.isFinite(price) && price > acc ? price : acc;
    }, 0);
  };

  const filterListings = () => {
    const min = priceRange[0];
    const max = priceRange[1] && priceRange[1] > 0 ? priceRange[1] : getMaxPrice();

    return listings.filter((listing) => listing.price && listing.price >= min && listing.price <= max);
  };

  useEffect(() => {
    window.deleteListing = (id) => deleteListingRef.current(id);

    window.viewDetails = (id) => {
      navigate(`/listings/listing/${id}`);
    };

    return () => {
      delete window.deleteListing;
      delete window.viewDetails;
    };
  }, [navigate]);

  useEffect(() => {
    if (mapContainer.current && !map.current) {
      const checkMapReady = () => {
        if (mapContainer.current?.map) {
          map.current = mapContainer.current.map;
        } else {
          setTimeout(checkMapReady, 100);
        }
      };
      checkMapReady();
    }
  }, []);

  const handleMapReady = (mapInstance) => {
    map.current = mapInstance;
  };

  const handleMapStyle = (value) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === 'STANDARD') {
          next.delete('style');
        } else {
          next.set('style', value);
        }
        if (value === 'SATELLITE') {
          next.delete('buildings');
        }
        return next;
      },
      { replace: true },
    );
  };

  const handlePriceRange = (val) => {
    const maxPrice = getMaxPrice();
    if (maxPrice <= 0) return; // skip until listings are loaded
    setPriceRange(val);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (val[0] === 0) {
          next.delete('priceMin');
        } else {
          next.set('priceMin', String(val[0]));
        }
        if (val[1] === 0 || val[1] >= maxPrice) {
          next.delete('priceMax');
        } else {
          next.set('priceMax', String(val[1]));
        }
        return next;
      },
      { replace: true },
    );
  };

  const fetchListings = async () => {
    actions.listingsData.getListingsForMap({
      jobId,
    });
  };

  useEffect(() => {
    fetchListings();
  }, [jobId]);

  useEffect(() => {
    if (!map.current) return;

    // Use duration: 0 so the map jumps straight to the target view instead of
    // animating from the zoomed-out initial state. This effect re-runs whenever
    // listings/filters change, and the fly/zoom animation was distracting on
    // every refresh.
    if (homeAddress?.coords) {
      if (distanceFilter > 0) {
        const bounds = getBoundsFromCenter([homeAddress.coords.lng, homeAddress.coords.lat], distanceFilter);

        map.current.fitBounds(bounds, {
          padding: 20,
          maxZoom: 15,
          duration: 0,
        });
      } else {
        map.current.flyTo({
          center: [homeAddress.coords.lng, homeAddress.coords.lat],
          zoom: 12,
          duration: 0,
        });
      }
    } else {
      const filtered = filterListings();
      const coords = filtered
        .filter((l) => l.latitude != null && l.longitude != null && l.latitude !== -1 && l.longitude !== -1)
        .map((l) => [l.longitude, l.latitude]);

      if (coords.length > 0) {
        const bounds = getBoundsFromCoords(coords);
        map.current.fitBounds(bounds, {
          padding: 50,
          maxZoom: 15,
          duration: 0,
        });
      }
    }
  }, [homeAddress?.address, distanceFilter, listings]);

  useEffect(() => {
    if (!map.current) return;

    if (homeMarker.current) {
      homeMarker.current.remove();
      homeMarker.current = null;
    }

    if (homeAddress?.coords) {
      const homePopup = document.createElement('div');
      homePopup.className = 'map-popup-content';
      const homeTitle = document.createElement('h4');
      homeTitle.textContent = t('map.popupHomeAddress');
      const homeText = document.createElement('p');
      homeText.textContent = homeAddress.address;
      homePopup.append(homeTitle, homeText);
      homeMarker.current = new maplibregl.Marker({ color: 'red' })
        .setLngLat([homeAddress.coords.lng, homeAddress.coords.lat])
        .setPopup(new maplibregl.Popup({ offset: 25 }).setDOMContent(homePopup))
        .addTo(map.current);
    }

    const buildListingPopup = (listing) => {
      const root = document.createElement('div');
      root.className = 'map-popup-content';

      const image = document.createElement('img');
      image.src = listing.image_url || no_image;
      image.alt = '';
      image.addEventListener('error', () => {
        image.src = no_image;
      });
      const title = document.createElement('h4');
      title.textContent = listing.title || t('common.na');
      const info = document.createElement('div');
      info.className = 'info';
      const selectedDelta = Number(listing[`${marketModel}_delta_percent`]);
      const fairPrice = Number(listing[`${marketModel}_fair_price_per_sqm`]);
      const facts = [
        [t('map.popupPrice'), listing.price ? `${listing.price} €` : t('common.na')],
        [t('map.popupAddress'), listing.address || t('common.na')],
        [t('map.popupJob'), listing.job_name || t('common.na')],
        [t('map.popupProvider'), listing.provider || t('common.na')],
        [t('map.popupSize'), listing.size != null ? `${listing.size} m²` : t('common.na')],
        ['Fair', Number.isFinite(fairPrice) ? `${fairPrice.toFixed(1)} €/m²` : t('common.na')],
        ['Delta', Number.isFinite(selectedDelta) ? `${selectedDelta.toFixed(1)}%` : t('common.na')],
      ];
      for (const [label, value] of facts) {
        const line = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = `${label}: `;
        line.append(strong, document.createTextNode(String(value)));
        info.append(line);
      }

      const actionsRow = document.createElement('div');
      actionsRow.className = 'map-popup-content__actions';
      const external = document.createElement('a');
      external.className = 'map-popup-content__linkButton';
      external.href = listing.link || '#';
      external.target = '_blank';
      external.rel = 'noopener noreferrer';
      external.textContent = '↗';
      const details = document.createElement('button');
      details.className = 'map-popup-content__detailsButton';
      details.type = 'button';
      details.textContent = t('map.popupViewDetails');
      details.addEventListener('click', () => navigate(`/listings/listing/${listing.id}`));
      const remove = document.createElement('button');
      remove.className = 'map-popup-content__deleteButton';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t('map.popupRemove');
      remove.addEventListener('click', () => deleteListingRef.current(listing.id));
      actionsRow.append(external, details, remove);
      info.append(actionsRow);
      root.append(image, title, info);
      return root;
    };

    const addMapLayers = () => {
      if (!map.current || !map.current.isStyleLoaded()) return;
      if (map.current.getLayer('distance-circle')) map.current.removeLayer('distance-circle');
      if (map.current.getLayer('distance-circle-outline')) map.current.removeLayer('distance-circle-outline');
      if (map.current.getSource('distance-circle-source')) map.current.removeSource('distance-circle-source');
      for (const layerId of ['listing-cluster-count', 'listing-clusters', 'listing-points']) {
        if (map.current.getLayer(layerId)) map.current.removeLayer(layerId);
      }
      if (map.current.getSource('listings-source')) map.current.removeSource('listings-source');

      if (distanceFilter > 0 && homeAddress?.coords) {
        const ret = generateCircleCoords([homeAddress.coords.lng, homeAddress.coords.lat], distanceFilter);

        map.current.addSource('distance-circle-source', {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [ret],
            },
          },
        });

        map.current.addLayer({
          id: 'distance-circle',
          type: 'fill',
          source: 'distance-circle-source',
          paint: {
            'fill-color': '#90EE90',
            'fill-opacity': 0.3,
          },
        });

        map.current.addLayer({
          id: 'distance-circle-outline',
          type: 'line',
          source: 'distance-circle-source',
          paint: {
            'line-color': '#006400',
            'line-width': 1,
          },
        });
      }

      const features = filterListings()
        .filter(
          (listing) =>
            listing.latitude != null &&
            listing.longitude != null &&
            listing.latitude !== -1 &&
            listing.longitude !== -1,
        )
        .map((listing) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [listing.longitude, listing.latitude] },
          properties: {
            id: listing.id,
            delta: Number.isFinite(Number(listing[`${marketModel}_delta_percent`]))
              ? Number(listing[`${marketModel}_delta_percent`])
              : null,
          },
        }));
      map.current.addSource('listings-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 44,
      });
      map.current.addLayer({
        id: 'listing-clusters',
        type: 'circle',
        source: 'listings-source',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#5b8ff9', 10, '#7067cf', 30, '#9b5de5'],
          'circle-radius': ['step', ['get', 'point_count'], 17, 10, 22, 30, 28],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.current.addLayer({
        id: 'listing-cluster-count',
        type: 'symbol',
        source: 'listings-source',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 },
        paint: { 'text-color': '#ffffff' },
      });
      map.current.addLayer({
        id: 'listing-points',
        type: 'circle',
        source: 'listings-source',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'case',
            ['==', ['get', 'delta'], null],
            '#718096',
            [
              'interpolate',
              ['linear'],
              ['get', 'delta'],
              -30,
              '#16864b',
              -10,
              '#62a86b',
              0,
              '#e5b94b',
              10,
              '#e17c45',
              30,
              '#c83e4d',
            ],
          ],
          'circle-radius': 7,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.92,
        },
      });
    };

    const onClusterClick = (event) => {
      const feature = map.current.queryRenderedFeatures(event.point, { layers: ['listing-clusters'] })[0];
      if (!feature) return;
      map.current
        .getSource('listings-source')
        .getClusterExpansionZoom(feature.properties.cluster_id)
        .then((zoom) => map.current.easeTo({ center: feature.geometry.coordinates, zoom }));
    };
    const byId = new globalThis.Map(listings.map((listing) => [String(listing.id), listing]));
    const onListingClick = (event) => {
      const feature = event.features?.[0];
      const listing = byId.get(String(feature?.properties?.id));
      if (!listing) return;
      new maplibregl.Popup({ offset: 12 })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(buildListingPopup(listing))
        .addTo(map.current);
    };
    const pointerOn = () => {
      map.current.getCanvas().style.cursor = 'pointer';
    };
    const pointerOff = () => {
      map.current.getCanvas().style.cursor = '';
    };
    const registerInteractions = () => {
      map.current.on('click', 'listing-clusters', onClusterClick);
      map.current.on('click', 'listing-points', onListingClick);
      map.current.on('mouseenter', 'listing-clusters', pointerOn);
      map.current.on('mouseleave', 'listing-clusters', pointerOff);
      map.current.on('mouseenter', 'listing-points', pointerOn);
      map.current.on('mouseleave', 'listing-points', pointerOff);
    };
    const initialize = () => {
      addMapLayers();
      registerInteractions();
    };
    if (map.current.isStyleLoaded()) initialize();
    else map.current.once('style.load', initialize);

    return () => {
      if (!map.current) return;
      map.current.off('style.load', initialize);
      map.current.off('click', 'listing-clusters', onClusterClick);
      map.current.off('click', 'listing-points', onListingClick);
      map.current.off('mouseenter', 'listing-clusters', pointerOn);
      map.current.off('mouseleave', 'listing-clusters', pointerOff);
      map.current.off('mouseenter', 'listing-points', pointerOn);
      map.current.off('mouseleave', 'listing-points', pointerOff);
    };
  }, [listings, priceRange, homeAddress, distanceFilter, marketModel, style, navigate]);

  return (
    <>
      <Headline text={t('map.title')} />
      <div className="map-view-container">
        {!homeAddress && (
          <Banner
            fullMode={true}
            type="warning"
            bordered
            closeIcon={null}
            style={{ marginBottom: '8px' }}
            description={
              <span>
                {t('map.noHomeAddressBefore')}
                <Link to="/userSettings">{t('map.noHomeAddressLink')}</Link>
                {t('map.noHomeAddressAfter')}
              </span>
            }
          />
        )}

        <Banner
          fullMode={true}
          type="info"
          bordered
          closeIcon={null}
          style={{ marginBottom: '8px' }}
          description={t('map.onlyValidAddresses')}
        />

        <div className="map-view-container__map-wrapper">
          <Map
            mapContainerRef={mapContainer}
            style={style}
            show3dBuildings={show3dBuildings}
            onMapReady={handleMapReady}
          />

          {/* Floating filter panel */}
          <div className="map-view-container__floating-panel">
            <div className="map-view-container__panel-row">
              <Text size="small" strong style={{ color: '#8892a4' }}>
                {t('map.filterJobLabel')}
              </Text>
              <Select
                placeholder={t('map.filterJobPlaceholder')}
                showClear
                size="small"
                onChange={(val) => setJobId(val)}
                value={jobId}
                style={{ width: 160 }}
              >
                {jobs?.map((j) => (
                  <Select.Option key={j.id} value={j.id}>
                    {j.name}
                  </Select.Option>
                ))}
              </Select>
            </div>

            <div className="map-view-container__panel-row">
              <Text size="small" strong style={{ color: '#8892a4' }}>
                {t('map.filterDistanceLabel')}
              </Text>
              <Select
                placeholder={t('map.filterDistanceNone')}
                size="small"
                onChange={(val) => setDistanceFilter(val)}
                value={distanceFilter}
                style={{ width: 100 }}
              >
                <Select.Option value={0}>{t('map.filterDistanceNone')}</Select.Option>
                <Select.Option value={5}>5 km</Select.Option>
                <Select.Option value={10}>10 km</Select.Option>
                <Select.Option value={15}>15 km</Select.Option>
                <Select.Option value={20}>20 km</Select.Option>
                <Select.Option value={25}>25 km</Select.Option>
              </Select>
            </div>

            <div className="map-view-container__panel-row">
              <Text size="small" strong style={{ color: '#8892a4' }}>
                {t('map.filterPriceLabel')}
              </Text>
              <div className="map-view-container__price-slider">
                <div className="map__rangesliderLabels">
                  <span>{priceRange[0]}</span>
                  <span>{priceRange[1]}</span>
                </div>
                <RangeSlider min={0} max={getMaxPrice()} step={100} value={priceRange} onInput={handlePriceRange} />
              </div>
            </div>

            <div className="map-view-container__panel-row">
              <Text size="small" strong style={{ color: '#8892a4' }}>
                {t('map.filterStyleLabel')}
              </Text>
              <Select size="small" value={style} onChange={(val) => handleMapStyle(val)} style={{ width: 110 }}>
                <Select.Option value="STANDARD">{t('map.filterStyleStandard')}</Select.Option>
                <Select.Option value="SATELLITE">{t('map.filterStyleSatellite')}</Select.Option>
              </Select>
            </div>

            <div className="map-view-container__panel-row">
              <Text size="small" strong style={{ color: '#8892a4' }}>
                Model
              </Text>
              <Select
                size="small"
                value={marketModel}
                onChange={(value) => setMarketModel(value)}
                style={{ width: 110 }}
              >
                <Select.Option value="gbm">GBM</Select.Option>
                <Select.Option value="ridge">Ridge</Select.Option>
              </Select>
            </div>

            <div className="map-view-container__legend" aria-label="Price versus fair-price legend">
              <span className="is-deal">Below fair</span>
              <span className="is-neutral">Near fair</span>
              <span className="is-expensive">Above fair</span>
            </div>

            <div className="map-view-container__panel-row">
              <Text size="small" strong style={{ color: '#8892a4' }}>
                {t('map.filter3dBuildings')}
              </Text>
              <Switch
                size="small"
                checked={show3dBuildings}
                onChange={(v) => setShow3dBuildings(v)}
                disabled={style === 'SATELLITE'}
              />
            </div>
          </div>
        </div>

        <ListingDeletionModal
          visible={deleteModalVisible}
          defaultDeleteType={defaultDeleteType}
          onConfirm={confirmListingDeletion}
          onCancel={() => {
            setDeleteModalVisible(false);
            setListingToDelete(null);
          }}
        />
      </div>
    </>
  );
}
